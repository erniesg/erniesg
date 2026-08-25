import type {
  NormalizedSourceBox,
  PdfImportProgress,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceRun,
  PdfTextOperationFilterPlan,
  PdfVisualAsset,
  PdfVisualRelationship,
  ReconstructionDiagnostic,
} from './import-types'
import {
  createSourceGeometryScriptTranscript,
  SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE,
} from './equation-geometry-transcript'
import {
  equationRenderOnlySourceRunIdentity,
  proveEquationRenderOnlySourceRunOwnerships,
  RENDER_ONLY_EQUATION_OWNERSHIP_EVIDENCE,
} from './equation-render-only-ownership'
import {
  computerOrLatinModernMathFont,
  contextualNeutralVerticalEllipsisFragment,
  equationTranscriptResolved,
  hasUnsupportedSourceMathRomanWord,
  justifiedUprightSourceMathToken,
  knownSourceMathFont,
  knownSourceMathGlyphFont,
  lineHasCompactSourceScriptIdentifier,
  lineHasSourceScriptGeometry,
  lineHasUnencodedSourceScriptGeometry,
  mathExtensionGlyphFragment,
  sourceEquationLineText,
  sourceMathExtensionScaffoldFragment,
  sourceMathFontProvenance,
  sourceMathRomanFont,
  unpublishableEquationTranscriptText,
  unreliableMathExtensionRun,
  unresolvedMathExtensionGlyphFragment,
  unresolvedMathExtensionRegion,
} from './pdf-equation-source-math'
import {
  detectExplicitHeaderNumericTableWithinProvenScope,
  detectHierarchicalTableWithinProvenScope,
  detectRectangularTableWithinProvenScope,
  detectTableNearCaption,
  detectTableWithinProvenScope,
  detectUniformTableWithinProvenScope,
  detectWrappedCellTableWithinProvenScope,
  detectWrappedHeaderTableWithinProvenScope,
  type PdfDetectedTableGrid,
} from './pdf-table-detection'
import {
  resolvePdfTableScope,
  type PdfTableScope,
  type PdfTableScopeResolution,
} from './pdf-table-scope'
import {
  completeSemanticTableScope,
  matchTableScopeResolution,
  type CompleteSemanticTableScope,
} from './pdf-visual-table-matching'
import {
  parsePdfScholarlyVisualLabel,
  type PdfScholarlyVisualLabel,
  type ParsedPdfScholarlyVisualLabel,
} from './pdf-scholarly-label'
import { proseDominantPdfMathSource } from './pdf-regions'
import { isBoundedPdfPageCropBox } from './pdf-page-crop'
import {
  canonicalTableFromLines,
  createHeadlessCompositePngAsset,
  createHeadlessCompositeSvgAsset,
  createTableAsset,
  createTextSvgAsset,
  type CanonicalTable,
} from './visual-assets'
import {
  runTableCandidateProvider,
  type TableCandidateProvider,
  type TableCandidateReceipt,
} from './table-candidate-provider'
import {
  decorativeNativeObjectIds,
  repeatedRectangleFallbackObjectIds,
  type PdfRectangleIndexEvidence,
} from './pdf-visual-native-artifacts'
import {
  completeCompositePdfVisualAsset as completeCompositeAsset,
  completeSingleSourcePdfVisualAsset as completeSingleSourceAsset,
  completeSourcePageCropPdfVisualAsset as completeSourcePageCropAsset,
  materiallyOverlapsPdfSourceText as materiallyOverlapsSourceText,
  mergePdfVisualAsset as mergeAsset,
  samePdfSourceBox as sameSourceBox,
  sourcePageCropFailureEvidence,
  sourcePageCropTouchesEdge,
  sourcePageCropValidationFailure,
  withSourceCropAttemptProvenance,
} from './pdf-visual-source-crops'
import {
  excludedEquationSourceBoxesForCrop,
  hasOverlappingUnownedEquationText,
  sourceBoxesIntersect,
  sourceTextOperationFilterPlanForEquationCrop,
  sourceTextPaintInventoryForPage,
  unownedSourceTextBoxesInEquationCrop,
} from './pdf-equation-source-crop'
import { sourceLineOrder, sourceRegionOrder } from './pdf-preformatted-source'
import { retainedCaptionText } from './pdf-preformatted-blocks'
import { boundedPreformattedBlocks } from './pdf-preformatted-panels'
import {
  captionLaneHorizontalBounds,
  captionLaneScopedRenderBox,
  captionSourceLaneMatches,
  captionSourceLaneMatchesBox,
  compatibleCaptionLaneColumns,
  compositeCandidateMayCrossCaptionLane,
  equationSourceRunOwnershipKey,
  FIGURE_OVERLAY_BOX_TOLERANCE,
  horizontalBoxOverlap,
  horizontalOverlapRatio,
  matchCandidate,
  matchRecord,
  MIN_CROSS_COLUMN_FIGURE_SPAN,
  pdfVisualMatchCandidateId,
  pdfVisualOwnershipExtentSha256,
  rounded,
  SOURCE_CROP_CONTAINMENT_TOLERANCE,
  sourceBoxWithinHorizontalBounds,
  TEXT_OVERLAY_PREFIX,
  visualCanonicalNodeId,
  type SourceHorizontalBounds,
  type VisualCandidate,
} from './pdf-visual-matching'
import {
  availableRegionsForTable,
  boxForLines,
  exactSourceLinesById,
  materiallyOverlappingSourceBoxes,
  neighborBoundedCropBoxes,
  nextSourceRegions,
  paddedEquationCropBox,
  paddedUnionBox,
  TABLE_SOURCE_CROP_RETRY_PADDINGS,
  tableRowBandCount,
  tableSourceCropRetryPaddings,
  unionBox,
  verticalBoxOverlap,
} from './pdf-visual-source-geometry'
import {
  CAPTION_BOUNDED_PANEL_BOTTOM_INSET,
  captionBoundedPanelRecoveryBoxes,
  captionTextBoundedFigureRetryBox,
  connectedFigureReservationContestedByTableCaption,
  connectedFigureReservationLineage,
  containedFigureOverlayLineage,
  fullyContainsBox,
  intersectSourceBox,
  intersectionArea,
  MIN_CAPTION_BOUNDED_FLOW_OVERLAY_LINE_COUNT,
  MIN_COMPOSITE_FIGURE_FRAGMENTS,
  MIN_DENSE_NATIVE_SCAFFOLD_FRAGMENT_COUNT,
  nativeOnlyFigureCandidate,
  preTableFigureReservationOverlayLineage,
  projectFigureLineageToAcceptedSourceCrop,
  renderScopeContainsCompleteFigureLineage,
  retainConnectedFigureReservationLineage,
  sourceLineageWithinRenderScope,
  strongFigureOwnershipKeys,
  trimStrongFigureCandidateOverlays,
} from './pdf-visual-figure-lineage'
import {
  adjacentPanelLabelOverlays,
  boxGap,
  connectedFigureRegionGroups,
  containsCenter,
  figureRegionSpatialIndex,
  isLargeVectorArtifact,
  MAX_SINGLE_COLUMN_FIGURE_WIDTH,
  owningCaptionForBox,
  PDF_VISUAL_COOPERATIVE_BATCH_SIZE,
  PDF_VISUAL_INDEX_COOPERATIVE_BATCH_SIZE,
  probablePanelLabelOverlayRegion,
  throwIfPdfVisualWorkAborted,
  unionObjectBox,
  yieldPdfVisualTask,
  type PdfFigureGroupingEvidence,
} from './pdf-visual-figure-grouping'
import {
  bindsDenseNativeFragmentSet,
  CAPTION_ENVELOPE_SOURCE_CROP_RETRY_PADDINGS,
  captionBoundedRenderBox,
  captionBoundedSemanticEnvelopeCandidates,
  coextensiveNativeLayers,
  isCompositeScaffold,
  MAX_REUSED_PAGE_BACKDROP_EDGE_INSET,
  provesCaptionBoundedNativeScaffold,
  renderBoxForGroup,
  textOverlayId,
} from './pdf-visual-caption-envelopes'
import {
  reconstructBoundedAlgorithms,
  type PdfFigureRasterizer as PdfFigureRasterizerContract,
} from './pdf-visual-algorithms'
export {
  decorativeNativeObjectIds,
  repeatedRectangleFallbackObjectIds,
  type PdfRectangleIndexEvidence,
} from './pdf-visual-native-artifacts'
export {
  equationSourceRunOwnershipKey,
  pdfVisualMatchCandidateId,
  pdfVisualOwnershipExtentSha256,
  VISUAL_MATCH_DECISION_SCHEMA_VERSION,
  visualCanonicalNodeId,
} from './pdf-visual-matching'

type PdfNativeObject = NonNullable<PdfPageAnalysis['objects']>[number]

export type PdfFigureRasterizer = PdfFigureRasterizerContract

export type PdfPartialRegionLineSelection = {
  regionId: string
  consumedLineIds: string[]
  retainedLineIds: string[]
}

// Diagram labels must remain outside canonical reading order and subordinate
// to the established native render scope. The area cap is a secondary bound;
// individually small fragments are not evidence that canonical prose is safe.
const MAX_FIGURE_TEXT_OVERLAY_AREA_RATIO = 0.2
const MAX_CAPTION_BOUNDED_FLOW_OVERLAY_AREA_RATIO = 0.45
const MAX_LAYERED_PANEL_FLOW_OVERLAY_AREA_RATIO = 0.9
const MAX_SINGLE_LINE_CHART_OVERLAY_CHARACTERS = 48
const MAX_SINGLE_LINE_CHART_OVERLAY_AREA_RATIO = 0.03
const MIN_REUSED_PAGE_BACKDROP_WIDTH = 0.6
const MIN_REUSED_PAGE_BACKDROP_HEIGHT = 0.2
const MIN_REUSED_PANEL_CLIP_WIDTH = 0.4
const MIN_REUSED_PANEL_CLIP_HEIGHT = 0.15
const MIN_EXACT_CROP_NATIVE_OBJECT_CONTAINMENT = 0.99
const MAX_DISPLAY_EQUATION_WIDTH = 0.82
const PREFORMATTED_SOURCE_CROP_PADDING = 0.012
const PREFORMATTED_SOURCE_CROP_RETRY_PADDINGS = [
  0.016, 0.02, 0.024, 0.028, 0.032, 0.04, 0.05,
] as const
const PREFORMATTED_NEIGHBOR_GAP_FRACTION = 0.8
const EQUATION_SOURCE_CROP_RETRY_PADDINGS = [
  0.006, 0.008, 0.01, 0.012, 0.014, 0.016, 0.02,
] as const
const EQUATION_SOURCE_CROP_RETRY_NEIGHBOR_GAP_FRACTIONS = [
  0.5, 0.75, 0.9,
] as const
const TABLE_SOURCE_CROP_NEIGHBOR_GAP_FRACTIONS = [0.25, 0.5, 0.75, 0.9] as const

function visualLabel(text: string) {
  const parsed = parsePdfScholarlyVisualLabel(text, { context: 'caption' })
  return parsed?.status === 'parsed'
    ? { ...parsed, sequence: parsed.identifier }
    : null
}

function dedicatedCaptionLabelStyle(
  run: PdfPageRegion['lines'][number]['runs'][number],
) {
  return (
    run.bold === true ||
    /(?:bold|black|demi|semibold|(?:^|[-_])medi(?:um)?(?:$|[-_]))/i.test(
      run.fontName,
    )
  )
}

function unstyledProseTableReference(region: PdfPageRegion) {
  const label = parsePdfScholarlyVisualLabel(region.text, {
    context: 'caption',
  })
  if (label?.status !== 'parsed' || label.kind !== 'table') return false
  const firstRun = region.lines
    .flatMap((line) => line.runs)
    .find((run) => run.text.trim())
  if (!firstRun || dedicatedCaptionLabelStyle(firstRun)) return false
  // A body run that contains both "Table N." and following prose is a
  // cross-reference split at a layout boundary, not source evidence for a
  // dedicated caption. Real source captions without run provenance remain
  // eligible but fail closed later if no unique source scope exists.
  return /^\s*\.\s+(?:thus|hence|therefore|consequently)\b/iu.test(
    firstRun.text.slice(label.consumedEnd),
  )
}

function reusedPageBackdropObjectIds(
  pages: PdfPageAnalysis[],
  repeatedRectangleObjectIds: ReadonlySet<string>,
) {
  const vectors = pages
    .flatMap((page) => page.objects ?? [])
    .filter(
      (object): object is PdfNativeObject & { assetId: string } =>
        object.kind === 'vector' && Boolean(object.assetId),
    )
  const pageBackdropAssetIds = new Set(
    vectors
      .filter((object) => {
        const box = object.box
        const reachesPageEdge =
          box.x <= MAX_REUSED_PAGE_BACKDROP_EDGE_INSET ||
          box.y <= MAX_REUSED_PAGE_BACKDROP_EDGE_INSET ||
          box.x + box.width >= 1 - MAX_REUSED_PAGE_BACKDROP_EDGE_INSET ||
          box.y + box.height >= 1 - MAX_REUSED_PAGE_BACKDROP_EDGE_INSET
        return (
          repeatedRectangleObjectIds.has(object.id) &&
          reachesPageEdge &&
          box.width >= MIN_REUSED_PAGE_BACKDROP_WIDTH &&
          box.height >= MIN_REUSED_PAGE_BACKDROP_HEIGHT
        )
      })
      .map((object) => object.assetId),
  )
  return new Set(
    vectors
      .filter(
        (object) =>
          pageBackdropAssetIds.has(object.assetId) &&
          object.box.width >= MIN_REUSED_PAGE_BACKDROP_WIDTH &&
          object.box.height >= MIN_REUSED_PAGE_BACKDROP_HEIGHT,
      )
      .map((object) => object.id),
  )
}

function reusedPanelClipObjectIds(
  pages: PdfPageAnalysis[],
  repeatedRectangleObjectIds: ReadonlySet<string>,
) {
  const vectors = pages
    .flatMap((page) => page.objects ?? [])
    .filter(
      (object): object is PdfNativeObject & { assetId: string } =>
        object.kind === 'vector' && Boolean(object.assetId),
    )
  return new Set(
    vectors
      .filter(
        (object) =>
          repeatedRectangleObjectIds.has(object.id) &&
          (object.box.x <= MAX_REUSED_PAGE_BACKDROP_EDGE_INSET ||
            object.box.y <= MAX_REUSED_PAGE_BACKDROP_EDGE_INSET) &&
          object.box.width >= MIN_REUSED_PANEL_CLIP_WIDTH &&
          object.box.height >= MIN_REUSED_PANEL_CLIP_HEIGHT,
      )
      .map((object) => object.id),
  )
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
        isProbableDisplayEquation(region) &&
        sourcePrintedEquationNumber(region) === null &&
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

async function figureCandidates(
  regions: PdfPageRegion[],
  captions: PdfPageRegion[],
  decorativeObjectIds: Set<string>,
  pageBackdropObjectIds: Set<string>,
  panelClipObjectIds: Set<string>,
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
function sourcePreservedFigureFallbackCandidate({
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

type PreformattedScopeReservation = {
  lineIds: Set<string>
  captionRegionIds: Set<string>
}

function preformattedScopeReservations(
  pages: PdfPageAnalysis[],
  regions: PdfPageRegion[],
  captionLabels: ReadonlyMap<PdfPageRegion, PdfScholarlyVisualLabel>,
): PreformattedScopeReservation {
  const lineIds = new Set<string>()
  const captionRegionIds = new Set<string>()
  const reserveRegion = (region: PdfPageRegion) => {
    for (const line of region.lines) lineIds.add(line.id)
  }

  // Regions already typed by the source adapter are semantic owners, even
  // when their visual rendition is unresolved. Generic listing detection must
  // not steal their lines or their captions and make the typed pass disappear.
  for (const region of regions) {
    if (['table', 'equation', 'figure'].includes(region.kind)) {
      reserveRegion(region)
    }
    if (
      region.kind === 'equation' ||
      hasMathExtensionFontProvenance(region) ||
      sourceMathFragment(region)
    ) {
      reserveRegion(region)
    }
  }

  const typedCaption = (region: PdfPageRegion) => {
    const label = captionLabels.get(region)
    if (!label) return null
    const firstRun = region.lines
      .flatMap((line) => line.runs)
      .find((run) => run.text.trim())
    if (
      region.kind !== 'caption' &&
      !(firstRun && dedicatedCaptionLabelStyle(firstRun))
    ) {
      return null
    }
    if (unstyledProseTableReference(region)) return null
    return label
  }

  for (const [caption, label] of captionLabels) {
    const typed = typedCaption(caption)
    if (!typed) continue

    // Caption-bounded program listings are the one typed-looking figure
    // envelope intentionally handled by the preformatted detector itself.
    // Leave that caption available to programListingBlocks.
    const programListing =
      typed.kind === 'figure' &&
      /\b(?:example|generated)\s+program\b|\bprogram\s+for\b/iu.test(
        caption.text,
      )
    if (!programListing) {
      captionRegionIds.add(caption.id)
      reserveRegion(caption)
    }

    if (typed.kind === 'table' || typed.kind === 'equation') {
      // These are the same bounded source lanes used by the typed visual pass.
      // Reserving them before generic detection prevents a monospaced table row
      // or formula fragment from becoming a competing code block.
      for (const source of nextSourceRegions(caption, regions, typed.kind)) {
        reserveRegion(source)
      }
    }

    if (typed.kind === 'figure') {
      const page = pages.find((candidate) => candidate.page === caption.page)
      const nativeBoxes = (page?.objects ?? [])
        .filter((object) => object.kind === 'image' || object.kind === 'vector')
        .map((object) => object.box)
      for (const source of regions) {
        if (source.page !== caption.page || source.id === caption.id) continue
        if (source.kind === 'figure' || source.kind === 'chart-label') {
          reserveRegion(source)
          continue
        }
        if (
          source.kind === 'body' ||
          source.kind === 'spanning' ||
          source.kind === 'side'
        ) {
          const overlapsNative = nativeBoxes.some(
            (nativeBox) =>
              intersectionArea(nativeBox, source.box) >
              Math.min(
                nativeBox.width * nativeBox.height,
                source.box.width * source.box.height,
              ) *
                0.2,
          )
          if (overlapsNative) reserveRegion(source)
        }
      }
    }
  }

  // Bibliography entries are intentionally source-backed prose/list structure,
  // not listings. Reserve an identifiable reference section before a leading
  // "References:" line can be used as a generic introducer.
  const bibliographyHeading = (value: string) =>
    /^(?:(?:\d+(?:\.\d+)*)[.)]?\s+)?(?:references|bibliography)\s*:?[\s]*$/iu.test(
      value.trim(),
    )
  const headings = regions.filter(
    (region) =>
      bibliographyHeading(region.text) ||
      region.lines.some((line) => bibliographyHeading(line.text)),
  )
  for (const heading of headings) {
    reserveRegion(heading)
    const following = regions
      .filter(
        (region) =>
          region.page === heading.page &&
          region.id !== heading.id &&
          region.column === heading.column &&
          region.box.y >= heading.box.y + heading.box.height - 0.004,
      )
      .sort(sourceRegionOrder)
    for (const region of following) {
      const entryLike = region.lines.some((line) =>
        /^(?:\[\s*\d+\s*\]|\d+[.)])\s+/u.test(line.text.trim()),
      )
      if (entryLike) reserveRegion(region)
    }
  }

  return { lineIds, captionRegionIds }
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
    sourceLineIds: textSources.flatMap((region) =>
      region.lines.map((line) => line.id),
    ),
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

function exactCropUniquelyOwnsNativeObject({
  sourceCropBox,
  ownerSourceBox,
  objectBox,
  ownerCaption,
  figureCaptions,
}: {
  sourceCropBox: NormalizedSourceBox
  ownerSourceBox: NormalizedSourceBox
  objectBox: NormalizedSourceBox
  ownerCaption: PdfPageRegion
  figureCaptions: readonly PdfPageRegion[]
}) {
  const objectArea = objectBox.width * objectBox.height
  if (
    objectArea <= 0 ||
    objectBox.page !== sourceCropBox.page ||
    objectBox.page !== ownerCaption.page ||
    intersectionArea(sourceCropBox, objectBox) / objectArea <
      MIN_EXACT_CROP_NATIVE_OBJECT_CONTAINMENT ||
    intersectionArea(ownerSourceBox, objectBox) / objectArea <
      MIN_EXACT_CROP_NATIVE_OBJECT_CONTAINMENT ||
    objectBox.y + objectBox.height >
      ownerCaption.box.y + FIGURE_OVERLAY_BOX_TOLERANCE ||
    horizontalOverlapRatio(sourceCropBox, ownerCaption.box) < 0.35
  ) {
    return false
  }
  return !figureCaptions.some(
    (caption) =>
      caption.id !== ownerCaption.id &&
      caption.page === ownerCaption.page &&
      caption.box.y >= objectBox.y - FIGURE_OVERLAY_BOX_TOLERANCE &&
      caption.box.y <=
        ownerCaption.box.y +
          ownerCaption.box.height +
          FIGURE_OVERLAY_BOX_TOLERANCE &&
      horizontalOverlapRatio(sourceCropBox, caption.box) >= 0.35,
  )
}

function displayEquationProseCue(text: string) {
  const proseWords = text.match(/[A-Za-z]{2,}/g) ?? []
  return (
    proseWords.length >= 2 &&
    /\b(?:the|this|that|these|those|we|our|for|with|from|where|which|using|use|used|each|value|model|models|result|results|example|examples|figure|table|equation|performance|activating|because|namely|allowing|represents|output|number|sharp|discontinuity|simple|optimizer|epochs|trained|gains|point|moving)\b/iu.test(
      text,
    )
  )
}

function sourceMathFragmentProseLead(
  text: string,
  runs: readonly PdfPageRegion['lines'][number]['runs'][number][],
) {
  // A body line can contain mostly math-font glyphs while still being a
  // prose instruction whose first word governs the expression that follows
  // (for example, “Consider E[…]”). Such a line must remain canonical text;
  // lending it to a neighboring display creates competing source ownership.
  const visibleRuns = runs.filter((run) => run.text.trim())
  const firstMathGlyphIndex = visibleRuns.findIndex((run) =>
    knownSourceMathGlyphFont(run.fontName),
  )
  if (firstMathGlyphIndex > 0) {
    const leadingRuns = visibleRuns.slice(0, firstMathGlyphIndex)
    if (
      hasUnsupportedSourceMathRomanWord(leadingRuns) ||
      leadingRuns.some(
        (run) =>
          !knownSourceMathFont(run.fontName) && /\p{L}{2,}/u.test(run.text),
      )
    ) {
      return true
    }
  }
  // Retain a lexical fallback for extractors that merge upright prose and
  // the following formula into one math-font run.
  return /^(?:assume|because|consider|define|given|let(?:['’]s)?|recall|since|suppose|take|where)\b/iu.test(
    text,
  )
}

function probableDisplayEquationText(sourceText: string) {
  const text = sourceText.replace(/\s+/g, ' ').trim()
  if (!text || text.length > 240) return false
  if (
    /^(?:\d{1,3}|[A-Za-z])[.)]\s+\S/u.test(text) ||
    /^\(\s*\d{1,3}\s*\)\s+\S/u.test(text) ||
    /^\(\s*[a-z]\s*\)\s+\S(?:.*\S)?\s+\(\s*[a-z]\s*=\s*[-+]?\d+(?:\.\d+)?\s*\)$/iu.test(
      text,
    )
  ) {
    return false
  }
  if (
    /(?:https?:\/\/|www\.|openreview|forum\?id=|\bdoi\s*:|\S+@\S+)/iu.test(
      text,
    ) ||
    /(?:^|\s)(?:id|doi)\s*=\s*[A-Za-z0-9_-]{6,}\.?$/u.test(text) ||
    /^(?:[A-Za-z0-9._~-]{1,32}\?)?(?:id|d|doi)=[A-Za-z0-9_-]{6,}\.?$/u.test(
      text,
    )
  ) {
    return false
  }
  if (
    /^(?:\d+(?:\.\d+)?\s+)?[rp]\s*=\s*[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s+[rp]\s*=\s*[-+]?(?:\d+(?:\.\d+)?|\.\d+))*$/iu.test(
      text,
    )
  ) {
    return false
  }
  if (/^[\s=+\-−×÷≤≥≈∼⊙→←]+$/u.test(text)) return false
  const proseWords = text.match(/[A-Za-z]{2,}/g) ?? []
  if (displayEquationProseCue(text)) return false
  const operators = text.match(/[=+\-−×÷∫∑√≤≥≈∼⊙∂∞∏∈∉→←]/gu)?.length ?? 0
  const compactLength = text.replace(/\s+/g, '').length
  const operatorDensity = compactLength > 0 ? operators / compactLength : 0
  const formulaOnly =
    /^[\p{L}\p{N}\p{Script=Greek}\s()[\]{},.|+*/=<>_^\-−×÷≤≥≈∼⊙∂∞∏∈∉→←]+$/u.test(
      text,
    )
  const hasRelation =
    /[\p{L}\p{N})\]}]\s*(?:=+|≤|≥|≈|∼|∈|∉|→|←)\s*[\p{L}\p{N}([{]/u.test(text)
  const hasLargeOperator = /[∫∑√∂∞∏⊙]/u.test(text)
  if (formulaOnly && proseWords.length === 0 && operators > 0) return true
  if (hasRelation) return proseWords.length <= 3 || operatorDensity >= 0.1
  return (
    (hasLargeOperator || operators > 0) &&
    proseWords.length <= 1 &&
    operatorDensity >= 0.12
  )
}

function hasMathExtensionFontProvenance(region: PdfPageRegion) {
  return region.lines.some((line) =>
    line.runs.some(
      (run) =>
        sourceMathFontProvenance(run.fontName)?.role === 'math-extension' &&
        run.text.trim(),
    ),
  )
}

export function isProbableDisplayEquation(region: PdfPageRegion) {
  const fontOrGeometryEvidence =
    hasMathExtensionFontProvenance(region) ||
    unresolvedMathExtensionRegion(region) ||
    hasAmbiguousStackedEquationGeometry([region])
  return (
    region.kind === 'equation' &&
    region.lines.length > 0 &&
    (probableDisplayEquationText(region.text) ||
      sourceMathFontOnlyContinuation(region) ||
      (fontOrGeometryEvidence && sourceMathFragment(region)))
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
  return /^\(\s*\d+(?:\.\d+){0,3}[a-z]?\s*\)$/i.test(region.text.trim())
}

function sourcePrintedEquationNumber(region: PdfPageRegion) {
  const text = region.text.replace(/\s+/gu, ' ').trim()
  const fragment = text.match(/^\(\s*(\d+(?:\.\d+){0,3}[a-z]?)\s*\)$/iu)?.[1]
  if (fragment) return fragment

  const embeddedMarginNumbers = region.lines.flatMap((line) => {
    const number = /^\(\s*(\d+(?:\.\d+){0,3}[a-z]?)\s*\)$/iu.exec(
      line.text.trim(),
    )?.[1]
    return number && line.box.x >= 0.72 ? [{ line, number }] : []
  })
  if (
    embeddedMarginNumbers.length === 1 &&
    region.lines.some((line) => {
      if (line.id === embeddedMarginNumbers[0].line.id) return false
      const lineFragment = {
        ...region,
        text: line.text,
        box: line.box,
        lines: [line],
      }
      return (
        hasMathExtensionFontProvenance(lineFragment) ||
        sourceMathFragment(lineFragment)
      )
    })
  ) {
    return embeddedMarginNumbers[0].number
  }

  const terminal = /(?:[,;]\s*|\s+)\(\s*(\d+(?:\.\d+){0,3}[a-z]?)\s*\)$/iu.exec(
    text,
  )
  if (!terminal || terminal.index <= 0) return null
  const formulaPrefix = text.slice(0, terminal.index).trim()
  const compactFormulaContinuation =
    region.kind === 'equation' &&
    (formulaPrefix.match(/[A-Za-z]{2,}/gu)?.length ?? 0) <= 2 &&
    /[=+\-−×÷∫∑√≤≥≈∼⊙∂∞∏∈∉→←]/u.test(formulaPrefix)
  return /(?:=+|≤|≥|≈|∼|∈|∉|→|←)/u.test(formulaPrefix) ||
    probableDisplayEquationText(formulaPrefix) ||
    compactFormulaContinuation
    ? terminal[1]
    : null
}

function alignedPrintedEquationNumber(
  source: PdfPageRegion,
  candidate: PdfPageRegion,
) {
  if (!printedEquationNumberFragment(candidate)) return false
  const sameEquationLane =
    source.column === candidate.column ||
    source.column === 'span' ||
    candidate.column === 'span'
  const sourceRight = source.box.x + source.box.width
  const crossColumnMarginContinuation =
    source.column === 'left' &&
    candidate.column === 'right' &&
    sourceRight >= 0.6 &&
    candidate.box.x >= 0.72
  // A printed number in the adjacent column can be vertically aligned with a
  // display by coincidence. Permit that margin label only after the owned
  // equation envelope itself reaches across the page midpoint; a narrow
  // left-column fraction cannot claim a right-column number.
  if (!sameEquationLane && !crossColumnMarginContinuation) return false
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

function hasAlignedPrintedEquationNumber(
  source: PdfPageRegion,
  regions: readonly PdfPageRegion[],
) {
  return regions.some(
    (candidate) =>
      candidate.id !== source.id &&
      candidate.page === source.page &&
      alignedPrintedEquationNumber(source, candidate),
  )
}

function printedEquationNumbersForDisplayRegion(
  source: PdfPageRegion,
  regions: readonly PdfPageRegion[],
) {
  const numbers = new Set<string>()
  const ownNumber = sourcePrintedEquationNumber(source)
  if (ownNumber) numbers.add(ownNumber.toLocaleLowerCase())
  for (const candidate of regions) {
    if (
      candidate.id === source.id ||
      candidate.page !== source.page ||
      !alignedPrintedEquationNumber(source, candidate)
    ) {
      continue
    }
    const alignedNumber = sourcePrintedEquationNumber(candidate)
    if (alignedNumber) numbers.add(alignedNumber.toLocaleLowerCase())
  }
  return numbers
}

function preservesPrintedEquationCardinality(
  displayRegions: PdfPageRegion[],
  candidate: PdfPageRegion,
  regions: readonly PdfPageRegion[],
) {
  const existingNumbers = new Set(
    displayRegions.flatMap((region) => [
      ...printedEquationNumbersForDisplayRegion(region, regions),
    ]),
  )
  const candidateNumbers = printedEquationNumbersForDisplayRegion(
    candidate,
    regions,
  )
  if (existingNumbers.size === 0 || candidateNumbers.size === 0) return true
  return new Set([...existingNumbers, ...candidateNumbers]).size === 1
}

function hasDisplayEquationEvidence(
  source: PdfPageRegion,
  regions: readonly PdfPageRegion[],
) {
  const sourceLineIds = new Set(source.lines.map((line) => line.id))
  if (
    source.lines.some((line) => {
      const provenance = detachedMathHostProvenance(line.id)
      return (
        provenance?.kind === 'linked' &&
        !sourceLineIds.has(provenance.hostLineId)
      )
    })
  ) {
    return false
  }
  return (
    isProbableDisplayEquation(source) ||
    (source.kind === 'equation' &&
      ((sourcePrintedEquationNumber(source) !== null &&
        !printedEquationNumberFragment(source)) ||
        hasAlignedPrintedEquationNumber(source, regions)))
  )
}

function adjacentDisplayEquationRegion(
  source: PdfPageRegion,
  candidate: PdfPageRegion,
  regions: readonly PdfPageRegion[],
) {
  const sameColumn =
    source.column === candidate.column ||
    source.column === 'span' ||
    candidate.column === 'span'
  const sourceNumber = sourcePrintedEquationNumber(source)
  const candidateNumber = sourcePrintedEquationNumber(candidate)
  const crossColumnNumberedContinuation =
    sourceNumber !== candidateNumber &&
    (sourceNumber !== null || candidateNumber !== null) &&
    !(sourceNumber !== null && candidateNumber !== null)
  if (
    source.page !== candidate.page ||
    (!sameColumn && !crossColumnNumberedContinuation)
  ) {
    return false
  }
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
  const sourceCenterY = source.box.y + source.box.height / 2
  const candidateCenterY = candidate.box.y + candidate.box.height / 2
  const upperCenterY = Math.min(sourceCenterY, candidateCenterY)
  const lowerCenterY = Math.max(sourceCenterY, candidateCenterY)
  const isIntermediateRegion = (region: PdfPageRegion) => {
    if (
      region.id === source.id ||
      region.id === candidate.id ||
      region.page !== source.page
    ) {
      return false
    }
    const centerY = region.box.y + region.box.height / 2
    if (centerY <= upperCenterY || centerY >= lowerCenterY) {
      return false
    }
    return true
  }
  const hasMathBridge = regions.some((region) => {
    if (
      !isIntermediateRegion(region) ||
      boxGap(source.box, region.box).vertical > 0.02 ||
      boxGap(candidate.box, region.box).vertical > 0.02
    ) {
      return false
    }
    return (
      mathExtensionGlyphFragment(region) ||
      sourceMathExtensionScaffoldFragment(region) ||
      contextualNeutralVerticalEllipsisFragment(region, [source, candidate]) ||
      sourceMathFragment(region) ||
      sourceMathFontOnlyContinuation(region) ||
      sourceMathOperatorFragment(region)
    )
  })
  const hasUprightOperatorBridge =
    sourceUprightMathOperatorContinuation(source) ||
    sourceUprightMathOperatorContinuation(candidate) ||
    regions.some(
      (region) =>
        isIntermediateRegion(region) &&
        boxGap(candidate.box, region.box).vertical <= 0.02 &&
        boxGap(candidate.box, region.box).horizontal <= 0.08 &&
        sourceUprightMathOperatorContinuation(region),
    )
  const hasPrintedNumber =
    printedEquationNumbersForDisplayRegion(source, regions).size > 0 ||
    printedEquationNumbersForDisplayRegion(candidate, regions).size > 0
  if (
    !sameColumn &&
    (gap.horizontal > 0.05 || verticalOverlap < minimumHeight * 0.25)
  ) {
    return false
  }
  return (
    (gap.vertical <= Math.max(0.012, minimumHeight) &&
      horizontalOverlap >= minimumWidth * 0.25) ||
    (gap.horizontal <= 0.12 && verticalOverlap >= minimumHeight * 0.25) ||
    (gap.vertical <= 0.04 &&
      horizontalOverlap >= minimumWidth * 0.25 &&
      hasMathBridge &&
      hasUprightOperatorBridge &&
      hasPrintedNumber) ||
    // PDF font metrics can place neighboring fragments from the same display
    // on slightly staggered baselines. Keep this diagonal bridge narrow so it
    // joins split formula runs without swallowing a separate display line.
    (gap.horizontal <= 0.025 && gap.vertical <= 0.012)
  )
}

function hasInterstitialEquationProseBoundary(
  source: PdfPageRegion,
  candidate: PdfPageRegion,
  regions: readonly PdfPageRegion[],
) {
  const sourceCenterY = source.box.y + source.box.height / 2
  const candidateCenterY = candidate.box.y + candidate.box.height / 2
  const upperCenterY = Math.min(sourceCenterY, candidateCenterY)
  const lowerCenterY = Math.max(sourceCenterY, candidateCenterY)
  if (lowerCenterY - upperCenterY <= 0.002) return false
  const corridorLeft = Math.min(source.box.x, candidate.box.x) - 0.01
  const corridorRight =
    Math.max(
      source.box.x + source.box.width,
      candidate.box.x + candidate.box.width,
    ) + 0.01
  const intermediateMathBridgeRegions = regions.filter((region) => {
    if (
      region.id === source.id ||
      region.id === candidate.id ||
      region.page !== source.page
    ) {
      return false
    }
    const centerY = region.box.y + region.box.height / 2
    if (
      centerY <= upperCenterY + 0.001 ||
      centerY >= lowerCenterY - 0.001 ||
      boxGap(source.box, region.box).vertical > 0.02 ||
      boxGap(candidate.box, region.box).vertical > 0.02 ||
      boxGap(source.box, region.box).horizontal > 0.08 ||
      boxGap(candidate.box, region.box).horizontal > 0.08
    ) {
      return false
    }
    return (
      mathExtensionGlyphFragment(region) ||
      sourceMathExtensionScaffoldFragment(region) ||
      sourceMathFragment(region) ||
      sourceMathFontOnlyContinuation(region) ||
      sourceMathOperatorFragment(region)
    )
  })
  return regions.some((region) => {
    if (
      region.id === source.id ||
      region.id === candidate.id ||
      region.page !== source.page ||
      !['body', 'spanning'].includes(region.kind)
    ) {
      return false
    }
    const centerY = region.box.y + region.box.height / 2
    const centerX = region.box.x + region.box.width / 2
    if (
      centerY <= upperCenterY + 0.001 ||
      centerY >= lowerCenterY - 0.001 ||
      centerX < corridorLeft ||
      centerX > corridorRight
    ) {
      return false
    }
    return (
      region.includedInReadingOrder &&
      region.text.trim().length > 0 &&
      !sourceMathExtensionScaffoldFragment(region) &&
      !contextualNeutralVerticalEllipsisFragment(region, [source, candidate]) &&
      !contextualSourceRomanScriptFragment(region, [
        source,
        candidate,
        ...intermediateMathBridgeRegions,
      ]) &&
      !sourceMathFragment(region) &&
      !sourceMathFontOnlyContinuation(region) &&
      !numericListAssignmentFragment(region) &&
      !bareNumericMathFragment(region) &&
      !printedEquationNumberFragment(region)
    )
  })
}

function inlineStackedFormulaBaseId(lineId: string) {
  return /^(.*-inline-stacked-\d+)-formula$/u.exec(lineId)?.[1] ?? null
}

function inlineStackedSiblingBaseId(lineId: string) {
  return /^(.*-inline-stacked-\d+)-(?:before|after)$/u.exec(lineId)?.[1] ?? null
}

type DetachedMathHostProvenance =
  | { kind: 'linked'; hostLineId: string }
  | { kind: 'ambiguous' }
  | { kind: 'malformed' }

function detachedMathHostProvenance(
  lineId: string,
): DetachedMathHostProvenance | null {
  if (!lineId.includes('-detached-math-')) return null
  const match = /-detached-math-\d+-host-(.+)$/u.exec(lineId)
  if (!match) return { kind: 'malformed' }
  if (match[1] === 'ambiguous') return { kind: 'ambiguous' }
  try {
    const hostLineId = decodeURIComponent(match[1])
    return hostLineId && encodeURIComponent(hostLineId) === match[1]
      ? { kind: 'linked', hostLineId }
      : { kind: 'malformed' }
  } catch {
    return { kind: 'malformed' }
  }
}

function detachedMathHostLineId(lineId: string) {
  const provenance = detachedMathHostProvenance(lineId)
  return provenance?.kind === 'linked' ? provenance.hostLineId : null
}

function unresolvedDetachedMathHost(region: PdfPageRegion) {
  return region.lines.some((line) => {
    const provenance = detachedMathHostProvenance(line.id)
    return provenance?.kind === 'ambiguous' || provenance?.kind === 'malformed'
  })
}

function inlineStackedFormulaBaseIds(region: PdfPageRegion) {
  return new Set(
    region.lines.flatMap((line) => {
      const baseId = inlineStackedFormulaBaseId(line.id)
      return baseId ? [baseId] : []
    }),
  )
}

function sourceProvedInlineStackedMathFormula(region: PdfPageRegion) {
  if (
    !['body', 'spanning', 'equation'].includes(region.kind) ||
    region.lines.length === 0 ||
    region.lines.some((line) => inlineStackedFormulaBaseId(line.id) === null)
  ) {
    return false
  }
  const runs = region.lines.flatMap((line) =>
    line.runs.filter((run) => run.text.trim()),
  )
  const neutralSourcePunctuation = (run: (typeof runs)[number]) =>
    /^[.,;:]+$/u.test(run.text.trim()) &&
    /(?:^|[+_-])STIXGeneral(?:[A-Za-z]*)?(?:$|[+_-])/iu.test(run.fontName)
  return (
    runs.length > 0 &&
    runs.every(
      (run) =>
        Number.isSafeInteger(run.sourceSequenceIndex) &&
        (knownSourceMathFont(run.fontName) || neutralSourcePunctuation(run)),
    ) &&
    runs.some((run) => knownSourceMathFont(run.fontName)) &&
    new Set(runs.map((run) => run.sourceSequenceIndex)).size === runs.length &&
    !hasUnsupportedSourceMathRomanWord(runs)
  )
}

interface InlineStackedSiblingEvidence {
  regionId: string
  lineId: string
}

function provedProseSplitInlineStackedFormulaBaseIds(
  regions: readonly PdfPageRegion[],
) {
  const ambiguousFormulaBaseIds = new Set<string>()
  const proseSiblingEvidence = new Map<string, InlineStackedSiblingEvidence[]>()
  const mathSiblingEvidence = new Map<string, InlineStackedSiblingEvidence[]>()

  for (const region of regions) {
    if (hasAmbiguousStackedEquationGeometry([region])) {
      for (const baseId of inlineStackedFormulaBaseIds(region)) {
        ambiguousFormulaBaseIds.add(baseId)
      }
    }
    for (const line of region.lines) {
      const formulaBaseId = inlineStackedFormulaBaseId(line.id)
      const siblingBaseId = inlineStackedSiblingBaseId(line.id)
      const baseId = formulaBaseId ?? siblingBaseId
      if (!baseId) continue
      const lineFragment = {
        ...region,
        text: line.text,
        box: line.box,
        lines: [line],
      }
      const proseDominantSibling = proseDominantPdfMathSource({
        text: line.text,
        width: line.box.width,
        runs: line.runs,
      })
      const unsupportedProseToken = (line.text.match(/\p{L}{2,}/gu) ?? []).some(
        (token) =>
          !/\p{Script=Greek}/u.test(token) &&
          !/^\p{Ll}\p{Lu}$/u.test(token) &&
          !/^d(?:\p{Ll}|\p{Script=Greek}){1,2}$/u.test(token) &&
          !/^(?:arg|cosh?|det|diag|dim|exp|gcd|lim|log|max|min|mod|sinh?|sqrt|tanh?|var)$/iu.test(
            token,
          ),
      )
      const formulaMathEvidence =
        formulaBaseId !== null &&
        ambiguousFormulaBaseIds.has(formulaBaseId) &&
        region.kind !== 'body' &&
        !proseDominantSibling &&
        sourceMathFragment(lineFragment)
      const siblingMathEvidence =
        siblingBaseId !== null &&
        region.kind !== 'body' &&
        !proseDominantSibling &&
        !unsupportedProseToken &&
        (sourceMathFragment(lineFragment) ||
          sourceMathFontOnlyContinuation(lineFragment) ||
          sourceMathOperatorFragment(lineFragment) ||
          numericListAssignmentFragment(lineFragment) ||
          bareNumericMathFragment(lineFragment))
      const evidence = { regionId: region.id, lineId: line.id }
      if (formulaMathEvidence || siblingMathEvidence) {
        const existing = mathSiblingEvidence.get(baseId) ?? []
        existing.push(evidence)
        mathSiblingEvidence.set(baseId, existing)
      } else if (
        siblingBaseId &&
        region.kind === 'body' &&
        (proseDominantSibling || unsupportedProseToken)
      ) {
        const existing = proseSiblingEvidence.get(baseId) ?? []
        existing.push(evidence)
        proseSiblingEvidence.set(baseId, existing)
      }
    }
  }

  return new Set(
    [...ambiguousFormulaBaseIds].filter((baseId) =>
      (proseSiblingEvidence.get(baseId) ?? []).some((prose) =>
        (mathSiblingEvidence.get(baseId) ?? []).some(
          (math) =>
            math.regionId !== prose.regionId && math.lineId !== prose.lineId,
        ),
      ),
    ),
  )
}

function numericListAssignmentFragment(region: PdfPageRegion) {
  const text = region.text.replace(/\s+/gu, ' ').trim()
  if (
    !text ||
    Array.from(text).length > 80 ||
    region.lines.length !== 1 ||
    region.box.width > 0.3 ||
    region.box.height > 0.04
  ) {
    return false
  }
  const match =
    /^[\p{L}](?:\s*[_^]\s*[\p{L}\p{N}]+)?\s*=\s*([\[(])\s*[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*,\s*[-+]?(?:\d+(?:\.\d+)?|\.\d+))+\s*([\])])$/u.exec(
      text,
    )
  if (!match || (match[1] === '[' ? match[2] !== ']' : match[2] !== ')')) {
    return false
  }
  const runs = region.lines[0].runs.filter((run) => run.text.trim())
  return (
    runs.length > 0 && runs.every((run) => knownSourceMathFont(run.fontName))
  )
}

function bareNumericMathFragment(region: PdfPageRegion) {
  // A display-equation fraction part (for example the bare denominator
  // `1000`) can reach line assembly as a line of the neighboring paragraph.
  // Reclaim it for the display scope only when every glyph run uses a
  // known source math-family font and the text is one short unparenthesized
  // number, so prose, printed equation numbers, and operator expressions can
  // never join an equation through this path.
  if (!['body', 'spanning', 'equation'].includes(region.kind)) return false
  const text = region.text.replace(/\s+/gu, ' ').trim()
  if (
    !text ||
    Array.from(text).length > 16 ||
    region.lines.length !== 1 ||
    region.box.width > 0.28 ||
    region.box.height > 0.04
  ) {
    return false
  }
  if (!/^[\p{N}][\p{N}.,]{0,11}$/u.test(text)) return false
  const runs = region.lines[0].runs.filter((run) => run.text.trim())
  return (
    runs.length > 0 && runs.every((run) => knownSourceMathFont(run.fontName))
  )
}

function sourceMathFragment(region: PdfPageRegion) {
  const text = region.text.replace(/\s+/gu, ' ').trim()
  if (
    !text ||
    Array.from(text).length > 40 ||
    region.lines.length === 0 ||
    region.lines.length > 2 ||
    region.box.width > 0.35 ||
    region.box.height > 0.06
  ) {
    return false
  }
  const runs = region.lines
    .flatMap((line) => line.runs)
    .filter((run) => run.text.trim())
  if (
    ['body', 'spanning'].includes(region.kind) &&
    sourceMathFragmentProseLead(text, runs)
  ) {
    return false
  }
  if (
    unpublishableEquationTranscriptText(text) &&
    proseDominantPdfMathSource({
      text,
      width: region.box.width,
      runs,
    })
  ) {
    return false
  }
  // Brackets alone are not mathematical evidence: OCR/font extraction can
  // label ordinary bracketed prose as CMMI and append one unresolved CMEX
  // glyph. Treat operators, numbers, and Greek letters as strong context, but
  // keep every other multi-letter word visible to the prose guard.
  const mathContextCharacter =
    /[\p{Script=Greek}\p{N}∆_=+*/<>^−×÷≤≥≈∼⊙∂∞∏∈∉→←∫∑√]/u
  const strongMathSignal = mathContextCharacter.test(text)
  const proseBoundary = /[\s\p{Ps}\p{Pe}\p{Pi}\p{Pf},.;:!?'"“”‘’]/u
  const unsupportedAlphabeticTokens = [...text.matchAll(/\p{L}{2,}/gu)]
    .map((match) => {
      const word = match[0]
      const start = match.index
      const end = start + word.length
      return {
        word,
        before: text[start - 1] ?? '',
        after: text[end] ?? '',
      }
    })
    .filter(
      ({ word, before, after }) =>
        !/^\p{Ll}\p{Lu}$/u.test(word) &&
        !/^d(?:\p{Ll}|\p{Script=Greek}){1,2}$/u.test(word) &&
        !/^(?:arg|cosh?|det|diag|dim|exp|gcd|lim|log|max|min|mod|sinh?|sqrt|tanh?|var)$/iu.test(
          word,
        ) &&
        after !== '(' &&
        !mathContextCharacter.test(before) &&
        !mathContextCharacter.test(after),
    )
  const standaloneUnsupportedTokenCount = unsupportedAlphabeticTokens.filter(
    ({ before, after }) =>
      (!before || proseBoundary.test(before)) &&
      (!after || proseBoundary.test(after)),
  ).length
  if (
    unsupportedAlphabeticTokens.length >= 2 &&
    (!strongMathSignal || standaloneUnsupportedTokenCount >= 2)
  ) {
    return false
  }
  const sourceCharacterCount = runs.reduce(
    (total, run) => total + Array.from(run.text.replace(/\s+/gu, '')).length,
    0,
  )
  if (sourceCharacterCount === 0) return false
  const mathCharacterCount = runs
    .filter((run) => knownSourceMathGlyphFont(run.fontName))
    .reduce(
      (total, run) => total + Array.from(run.text.replace(/\s+/gu, '')).length,
      0,
    )
  const mathFontRatio = mathCharacterCount / sourceCharacterCount
  const sourceScriptGeometry =
    region.lines.some(
      (line) =>
        lineHasSourceScriptGeometry(line) ||
        lineHasCompactSourceScriptIdentifier(line),
    ) || hasAmbiguousStackedEquationGeometry([region])
  const hasMathToken =
    /[\p{Script=Greek}\p{N}_′″=+\-−×÷≤≥≈∼⊙∂∞∏∫∑√∈∉→←]/u.test(text) ||
    /(?:^|[^\p{L}])(?:arg|cosh?|diag|exp|log|max|min|sinh?|sqrt|tanh?|var)\s*\(/iu.test(
      text,
    )
  const hasMathFunctionToken =
    mathFontRatio >= 0.35 &&
    /(?:^|[^\p{L}])(?:arg|cosh?|diag|exp|log|max|min|sinh?|sqrt|tanh?|var)(?:$|[^\p{L}])/iu.test(
      text,
    )
  return (
    (mathFontRatio >= 0.35 || sourceScriptGeometry) &&
    (hasMathToken ||
      hasMathFunctionToken ||
      sourceScriptGeometry ||
      (mathFontRatio >= 0.8 && unsupportedAlphabeticTokens.length === 0))
  )
}

function sourceMathFontOnlyContinuation(region: PdfPageRegion) {
  // PDF line assembly can detach the integrand to the right of a large
  // operator even though every glyph still carries source math-font
  // provenance. Keep this recovery narrower than sourceMathFragment: it is
  // only a short, single-line continuation with structural math punctuation,
  // at least one math-glyph run, and no ordinary prose token.
  const text = region.text.replace(/\s+/gu, ' ').trim()
  if (
    !text ||
    Array.from(text).length > 40 ||
    region.lines.length !== 1 ||
    region.box.width > (region.kind === 'equation' ? 0.35 : 0.18) ||
    region.box.height > 0.04
  ) {
    return false
  }
  const proseWords = text.match(/[A-Za-z]{3,}/gu) ?? []
  if (
    proseWords.some(
      (word) =>
        !/^(?:arg|cosh?|det|diag|dim|exp|gcd|lim|log|max|min|mod|sinh?|sqrt|tanh?|var)$/iu.test(
          word,
        ),
    )
  ) {
    return false
  }
  // Commas and semicolons alone are not structural math evidence: short
  // Computer Modern prose can use CMMI for its variables while keeping the
  // surrounding words in CMR (for example, “if x is y,”).
  if (!/[()[\]{}:=+\-−×÷≤≥≈∼˜⊙∂∞∏∈∉→←]/u.test(text)) {
    return false
  }
  const runs = region.lines[0].runs.filter((run) => run.text.trim())
  if (hasUnsupportedSourceMathRomanWord(runs)) {
    return false
  }
  return (
    runs.length > 0 &&
    runs.every((run) => knownSourceMathFont(run.fontName)) &&
    runs.some((run) => knownSourceMathGlyphFont(run.fontName))
  )
}

function sourceUprightMathOperatorContinuation(region: PdfPageRegion) {
  const text = region.text.replace(/\s+/gu, ' ').trim()
  const match = /^(?:=|≤|≥|≈|∼)\s*(\p{L}+(?:\s+\p{L}+){0,2})$/u.exec(text)
  if (
    region.kind !== 'equation' ||
    region.lines.length !== 1 ||
    region.box.width > 0.18 ||
    region.box.height > 0.04 ||
    !match
  ) {
    return false
  }
  const tokens = match[1].split(/\s+/u)
  const runs = region.lines[0].runs.filter((run) => run.text.trim())
  return (
    tokens.every(justifiedUprightSourceMathToken) &&
    runs.length > 0 &&
    runs.every((run) => sourceMathRomanFont(run.fontName))
  )
}

function contextualSourceRomanScriptFragment(
  region: PdfPageRegion,
  ownedRegions: readonly PdfPageRegion[],
) {
  const text = region.text.replace(/\s+/gu, '').trim()
  if (
    !/^[A-Za-z]$/u.test(text) ||
    region.lines.length !== 1 ||
    region.box.width > 0.04 ||
    region.box.height > 0.02 ||
    ownedRegions.length === 0
  ) {
    return false
  }
  const runs = region.lines[0].runs.filter((run) => run.text.trim())
  if (
    runs.length === 0 ||
    !runs.every((run) => sourceMathRomanFont(run.fontName))
  ) {
    return false
  }
  const ownedRuns = ownedRegions.flatMap((owned) =>
    owned.lines.flatMap((line) => line.runs.filter((run) => run.text.trim())),
  )
  const maximumOwnedFontSize = Math.max(
    0,
    ...ownedRuns.map((run) => run.fontSize),
  )
  const ownedEnvelope = unionBox([...ownedRegions])
  const centerX = region.box.x + region.box.width / 2
  const nearOwnedEnvelope =
    centerX >= ownedEnvelope.x &&
    centerX <= ownedEnvelope.x + ownedEnvelope.width &&
    boxGap(ownedEnvelope, region.box).vertical <= 0.015
  const ownedStackedMath =
    ownedRegions.some(
      (owned) =>
        hasAmbiguousStackedEquationGeometry([owned]) ||
        owned.lines.some((line) =>
          line.runs.some(
            (run) =>
              sourceMathFontProvenance(run.fontName)?.role === 'math-extension',
          ),
        ),
    ) && ownedRuns.some((run) => sourceMathRomanFont(run.fontName))
  return (
    maximumOwnedFontSize > 0 &&
    Math.max(...runs.map((run) => run.fontSize)) <=
      maximumOwnedFontSize * 0.82 &&
    nearOwnedEnvelope &&
    ownedStackedMath
  )
}

function contextualStixMathOperatorFragment(region: PdfPageRegion) {
  const text = region.text.replace(/\s+/gu, ' ').trim()
  if (
    region.lines.length !== 1 ||
    region.box.width > 0.08 ||
    region.box.height > 0.04 ||
    !/^(?:arg|cosh?|diag|exp|log|max|min|sinh?|sqrt|tanh?|var)$/iu.test(text)
  ) {
    return false
  }
  const runs = region.lines[0].runs.filter((run) => run.text.trim())
  return (
    runs.length > 0 &&
    runs.every((run) =>
      /(?:^|[+_-])STIXGeneral(?:[A-Za-z]*)?(?:$|[+_-])/iu.test(run.fontName),
    )
  )
}

function sourceMathOperatorFragment(region: PdfPageRegion) {
  const text = region.text.replace(/\s+/gu, '').trim()
  if (
    !text ||
    Array.from(text).length > 8 ||
    region.lines.length !== 1 ||
    region.box.width > 0.08 ||
    region.box.height > 0.04 ||
    !/^[()[\]{}.,;:|=+*/<>_\-−×÷≤≥≈∼˜⊙∂∞∑∏∈∉→←]+$/u.test(text) ||
    !/[=+\-−×÷≤≥≈∼˜⊙∂∞∑∏∈∉→←]/u.test(text)
  ) {
    return false
  }
  const runs = region.lines[0].runs.filter((run) => run.text.trim())
  return (
    runs.length > 0 &&
    runs.every(
      (run) =>
        knownSourceMathFont(run.fontName) ||
        /(?:^|[+_-])STIXGeneral(?:[A-Za-z]*)?(?:$|[+_-])/iu.test(run.fontName),
    )
  )
}

function sourceMathFontTranscript(regions: PdfPageRegion[]) {
  if (
    !equationTranscriptResolved(regions) ||
    !regions.some((region) => sourcePrintedEquationNumber(region) !== null)
  ) {
    return null
  }
  const lines = regions.flatMap((region) => region.lines)
  const runs = lines
    .flatMap((line) => line.runs)
    .filter((run) => run.text.trim())
  const sourceText = sourceEquationLineText(regions)
  const sourceCharactersComplete = lines.every(
    (line) =>
      line.runs
        .map((run) => run.text)
        .join('')
        .replace(/\s+/gu, '') === line.text.replace(/\s+/gu, ''),
  )
  const nonMathText = runs
    .filter((run) => !computerOrLatinModernMathFont(run.fontName))
    .map((run) => run.text)
    .join('')
  if (
    !sourceText ||
    sourceText.length > 240 ||
    !sourceCharactersComplete ||
    runs.filter((run) => computerOrLatinModernMathFont(run.fontName)).length <
      3 ||
    !lines.some(lineHasSourceScriptGeometry) ||
    /[^\s()[\]{},.;:_0-9]/u.test(nonMathText) ||
    !/[\p{L}\p{N})\]}]\s*=\s*[\p{L}\p{N}([{]/u.test(sourceText)
  ) {
    return null
  }
  return sourceText
}

function equationLineText(line: PdfPageRegion['lines'][number]) {
  const runs = [...line.runs]
    .filter(
      (run) =>
        run.text.trim() &&
        !unpublishableEquationTranscriptText(run.text) &&
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

function sourceRunUnionBox(
  runs: readonly PdfPageRegion['lines'][number]['runs'][number][],
) {
  const left = Math.min(...runs.map((run) => run.x))
  const top = Math.min(...runs.map((run) => run.y))
  const right = Math.max(...runs.map((run) => run.x + run.width))
  const bottom = Math.max(...runs.map((run) => run.y + run.height))
  return {
    page: runs[0].page,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
    rotation: runs[0].rotation,
    method: runs.some((run) => run.method === 'ocr')
      ? ('ocr' as const)
      : ('pdf-text' as const),
  }
}

function sourceSequenceRunText(
  runs: readonly PdfPageRegion['lines'][number]['runs'][number][],
) {
  let text = ''
  for (const [index, run] of runs.entries()) {
    const token = run.text.trim()
    if (!token) continue
    const previous = runs[index - 1]
    const sourceWhitespace =
      previous !== undefined &&
      run.sourceWhitespaceBefore === 'pdf-text-item' &&
      run.sourceWhitespacePredecessorIndex === previous.sourceSequenceIndex
    text += `${text && sourceWhitespace ? ' ' : ''}${token}`
  }
  return text.replace(/\s+/gu, ' ').trim()
}

function sourceSequenceLinkedMathRuns(
  left: PdfPageRegion['lines'][number]['runs'][number],
  right: PdfPageRegion['lines'][number]['runs'][number],
) {
  return (
    (Number.isSafeInteger(left.sourceSequenceIndex) &&
      right.sourceWhitespaceBefore === 'pdf-text-item' &&
      right.sourceWhitespacePredecessorIndex === left.sourceSequenceIndex) ||
    (Number.isSafeInteger(right.sourceSequenceIndex) &&
      left.sourceWhitespaceBefore === 'pdf-text-item' &&
      left.sourceWhitespacePredecessorIndex === right.sourceSequenceIndex)
  )
}

function splitSourceProvedAnswerCueEquations(
  regions: PdfPageRegion[],
  consumedRegionIds: ReadonlySet<string>,
) {
  const existingRegionIds = new Set(regions.map((region) => region.id))
  const existingLineIds = new Set(
    regions.flatMap((region) => region.lines.map((line) => line.id)),
  )
  for (let regionIndex = 0; regionIndex < regions.length; regionIndex += 1) {
    const region = regions[regionIndex]
    if (
      consumedRegionIds.has(region.id) ||
      !['body', 'spanning'].includes(region.kind) ||
      region.lines.length !== 1 ||
      region.nativeObjectIds.length > 0 ||
      !region.includedInReadingOrder
    ) {
      continue
    }
    const line = region.lines[0]
    const visibleRuns = line.runs.filter((run) => run.text.trim())
    if (
      visibleRuns.length < 3 ||
      visibleRuns.some(
        (run) => !Number.isSafeInteger(run.sourceSequenceIndex),
      ) ||
      new Set(visibleRuns.map((run) => run.sourceSequenceIndex)).size !==
        visibleRuns.length
    ) {
      continue
    }
    const sourceOrderedRuns = [...visibleRuns].sort(
      (left, right) => left.sourceSequenceIndex! - right.sourceSequenceIndex!,
    )
    let cueRuns: typeof sourceOrderedRuns | null = null
    let equationRuns: typeof sourceOrderedRuns | null = null
    let cueText = ''
    for (
      let prefixLength = 1;
      prefixLength < sourceOrderedRuns.length;
      prefixLength += 1
    ) {
      const candidateCueRuns = sourceOrderedRuns.slice(0, prefixLength)
      const candidateCueText = sourceSequenceRunText(candidateCueRuns)
      if (!/^(?:final\s+)?answer\s*:\s*$/iu.test(candidateCueText)) {
        continue
      }
      const candidateEquationRuns = sourceOrderedRuns.slice(prefixLength)
      if (
        candidateEquationRuns.length === 0 ||
        candidateEquationRuns.some(
          (run) => sourceMathFontProvenance(run.fontName) === null,
        )
      ) {
        continue
      }
      cueRuns = candidateCueRuns
      equationRuns = candidateEquationRuns
      cueText = candidateCueText
      break
    }
    if (!cueRuns || !equationRuns) continue

    const adjacentMathRegions = regions.filter((candidate) => {
      if (
        candidate.id === region.id ||
        candidate.page !== region.page ||
        consumedRegionIds.has(candidate.id) ||
        !(
          candidate.kind === 'equation' ||
          sourceMathFragment(candidate) ||
          sourceMathOperatorFragment(candidate)
        )
      ) {
        return false
      }
      const gap = boxGap(region.box, candidate.box)
      if (
        gap.horizontal > 0.08 ||
        gap.vertical > 0.04 ||
        !(
          region.column === candidate.column ||
          region.column === 'span' ||
          candidate.column === 'span'
        )
      ) {
        return false
      }
      return equationRuns!.some((equationRun) =>
        candidate.lines.some((candidateLine) =>
          candidateLine.runs.some((candidateRun) =>
            sourceSequenceLinkedMathRuns(equationRun, candidateRun),
          ),
        ),
      )
    })
    if (adjacentMathRegions.length === 0) continue

    const equationRegionId = `${region.id}-answer-equation`
    const equationLineId = `${line.id}-answer-equation`
    if (
      existingRegionIds.has(equationRegionId) ||
      existingLineIds.has(equationLineId)
    ) {
      continue
    }
    const cueBox = sourceRunUnionBox(cueRuns)
    const equationBox = sourceRunUnionBox(equationRuns)
    const equationText = sourceSequenceRunText(equationRuns)
    const equationRegion: PdfPageRegion = {
      ...region,
      id: equationRegionId,
      kind: 'equation',
      text: equationText,
      box: equationBox,
      lines: [
        {
          id: equationLineId,
          text: equationText,
          fontSize: line.fontSize,
          box: equationBox,
          runs: equationRuns,
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: false,
    }
    region.text = cueText
    region.box = cueBox
    region.lines = [
      {
        id: line.id,
        text: cueText,
        fontSize: line.fontSize,
        box: cueBox,
        runs: cueRuns,
      },
    ]
    regions.splice(regionIndex + 1, 0, equationRegion)
    existingRegionIds.add(equationRegionId)
    existingLineIds.add(equationLineId)
    regionIndex += 1
  }
}

function sourceSequenceEquationOwnerRegionIds(
  candidate: PdfPageRegion,
  regions: readonly PdfPageRegion[],
) {
  return new Set(
    regions
      .filter(
        (region) =>
          region.id !== candidate.id &&
          region.page === candidate.page &&
          region.kind === 'equation' &&
          hasDisplayEquationEvidence(region, regions) &&
          region.lines.some((line) =>
            line.runs.some((ownerRun) =>
              candidate.lines.some((candidateLine) =>
                candidateLine.runs.some((candidateRun) =>
                  sourceSequenceLinkedMathRuns(ownerRun, candidateRun),
                ),
              ),
            ),
          ),
      )
      .map((region) => region.id),
  )
}

function hasAmbiguousStackedEquationGeometry(regions: PdfPageRegion[]) {
  const lines = regions
    .flatMap((region) => region.lines)
    .filter(
      (line) =>
        line.text.trim().length > 0 &&
        !/^\(\s*\d+[a-z]?\s*\)$/iu.test(line.text.trim()),
    )
  for (const line of lines) {
    const runs = line.runs.filter((run) => run.text.trim())
    if (runs.length < 2) continue
    const maximumFontSize = Math.max(...runs.map((run) => run.fontSize))
    for (let leftIndex = 0; leftIndex < runs.length; leftIndex += 1) {
      const left = runs[leftIndex]
      if (left.fontSize > maximumFontSize * 0.86) {
        continue
      }
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < runs.length;
        rightIndex += 1
      ) {
        const right = runs[rightIndex]
        if (right.fontSize > maximumFontSize * 0.86) {
          continue
        }
        const horizontalOverlap = Math.max(
          0,
          Math.min(left.x + left.width, right.x + right.width) -
            Math.max(left.x, right.x),
        )
        const minimumWidth = Math.min(left.width, right.width)
        if (
          minimumWidth <= 0 ||
          horizontalOverlap < minimumWidth * 0.7 ||
          Math.abs(left.x + left.width / 2 - (right.x + right.width / 2)) >
            Math.max(0.008, Math.max(left.width, right.width) * 0.3)
        ) {
          continue
        }
        const leftCenterY = left.y + left.height / 2
        const rightCenterY = right.y + right.height / 2
        const minimumHeight = Math.min(left.height, right.height)
        const verticalGap = Math.max(
          left.y - (right.y + right.height),
          right.y - (left.y + left.height),
          0,
        )
        if (
          Math.abs(leftCenterY - rightCenterY) >=
            Math.max(0.003, minimumHeight * 0.45) &&
          verticalGap <= Math.max(0.006, minimumHeight * 0.7)
        ) {
          return true
        }
      }
    }
  }
  for (let leftIndex = 0; leftIndex < lines.length; leftIndex += 1) {
    const left = lines[leftIndex].box
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < lines.length;
      rightIndex += 1
    ) {
      const right = lines[rightIndex].box
      if (
        left.page !== right.page ||
        left.rotation !== right.rotation ||
        left.width <= 0 ||
        right.width <= 0 ||
        left.height <= 0 ||
        right.height <= 0
      ) {
        continue
      }
      const leftCenterY = left.y + left.height / 2
      const rightCenterY = right.y + right.height / 2
      const minimumHeight = Math.min(left.height, right.height)
      if (
        Math.abs(leftCenterY - rightCenterY) <=
        Math.max(0.001, minimumHeight * 0.15)
      ) {
        continue
      }
      const verticalGap = Math.max(
        left.y - (right.y + right.height),
        right.y - (left.y + left.height),
        0,
      )
      if (verticalGap > Math.max(0.003, minimumHeight * 0.35)) continue
      const horizontalOverlap = Math.max(
        0,
        Math.min(left.x + left.width, right.x + right.width) -
          Math.max(left.x, right.x),
      )
      const minimumWidth = Math.min(left.width, right.width)
      if (horizontalOverlap < minimumWidth * 0.75) continue
      const maximumWidth = Math.max(left.width, right.width)
      const widthRatio = minimumWidth / maximumWidth
      const leftCenterX = left.x + left.width / 2
      const rightCenterX = right.x + right.width / 2
      const boxesVerticallyOverlap = verticalGap === 0
      const centersAligned =
        Math.abs(leftCenterX - rightCenterX) <=
        Math.max(0.012, maximumWidth * 0.12)
      if (centersAligned && (widthRatio <= 0.8 || boxesVerticallyOverlap)) {
        return true
      }
    }
  }
  for (const candidate of lines) {
    const candidateCenterY = candidate.box.y + candidate.box.height / 2
    const upperLines = lines.filter((line) => {
      if (
        line.id === candidate.id ||
        line.box.page !== candidate.box.page ||
        line.box.rotation !== candidate.box.rotation
      ) {
        return false
      }
      const centerY = line.box.y + line.box.height / 2
      const verticalGap = Math.max(
        candidate.box.y - (line.box.y + line.box.height),
        0,
      )
      return (
        centerY <
          candidateCenterY -
            Math.max(
              0.001,
              Math.min(line.box.height, candidate.box.height) * 0.15,
            ) && verticalGap <= 0.015
      )
    })
    if (upperLines.length < 2) continue
    const upperLeft = Math.min(...upperLines.map((line) => line.box.x))
    const upperRight = Math.max(
      ...upperLines.map((line) => line.box.x + line.box.width),
    )
    const upperWidth = upperRight - upperLeft
    if (upperWidth <= 0 || candidate.box.width / upperWidth > 0.4) {
      continue
    }
    const upperCenterX = upperLeft + upperWidth / 2
    const candidateCenterX = candidate.box.x + candidate.box.width / 2
    if (
      Math.abs(candidateCenterX - upperCenterX) <=
      Math.max(0.012, upperWidth * 0.12)
    ) {
      return true
    }
  }
  return false
}

export function hasUnprovedTwoDimensionalEquationTranscript(
  regions: readonly PdfPageRegion[],
) {
  return (
    hasAmbiguousStackedEquationGeometry([...regions]) ||
    regions.some((region) =>
      region.lines.some(lineHasUnencodedSourceScriptGeometry),
    )
  )
}

function sourceEquationTranscript(regions: PdfPageRegion[]) {
  // PDF text order cannot distinguish a tightly stacked numerator/denominator
  // from a linear continuation. Preserve the source crop, but do not invent a
  // one-dimensional semantic transcript for that geometry.
  if (hasUnprovedTwoDimensionalEquationTranscript(regions)) return null
  // Likewise, source font geometry can prove that a run is a superscript or
  // subscript while the extracted line text merely concatenates that run with
  // its base. Unless the transcript itself carries an explicit script marker,
  // publishing the flattened text would certify semantics the source extractor
  // did not recover.
  const reconstructed = equationSourceText(regions)
  const sourceOwnedMathTranscript =
    regions.some(
      (region) =>
        region.kind === 'equation' &&
        probableDisplayEquationText(equationSourceText([region])),
    ) &&
    regions.every(
      (region) =>
        region.kind === 'equation' ||
        sourceMathFragment(region) ||
        numericListAssignmentFragment(region) ||
        printedEquationNumberFragment(region),
    )
  if (
    equationTranscriptResolved(regions) &&
    (probableDisplayEquationText(reconstructed) || sourceOwnedMathTranscript)
  ) {
    return {
      text: reconstructed,
      evidence: ['source-text-alt'],
    }
  }
  const mathFontTranscript = sourceMathFontTranscript(regions)
  return mathFontTranscript
    ? {
        text: mathFontTranscript,
        evidence: [
          'source-text-alt',
          'source-math-font-transcript',
          'source-script-geometry',
        ],
      }
    : null
}

function componentAttachableSequenceOwnerCluster(
  candidate: PdfPageRegion,
  ownerRegionIds: ReadonlySet<string>,
  displayRegions: readonly PdfPageRegion[],
  regions: readonly PdfPageRegion[],
  consumedRegionIds: ReadonlySet<string>,
  reservedLineIds: ReadonlySet<string>,
) {
  // Walk the transitive source-sequence ownership cluster reachable from the
  // candidate. The cluster stays internal to the growing display component
  // only if every linked owner row is itself attachable: an adjacent,
  // unreserved display-equation row in the same column band that preserves
  // printed-number cardinality and the bounded display envelope. Any owner
  // that fails these layout proofs is evidence of a different display, so the
  // candidate must not be captured.
  const displayRegionIds = new Set(displayRegions.map((region) => region.id))
  const regionsById = new Map(regions.map((region) => [region.id, region]))
  const visitedRegionIds = new Set<string>([candidate.id])
  const clusterRegions = new Map<string, PdfPageRegion>([
    [candidate.id, candidate],
  ])
  const pending = [...ownerRegionIds]
  while (pending.length > 0) {
    const ownerRegionId = pending.pop()!
    if (visitedRegionIds.has(ownerRegionId)) continue
    visitedRegionIds.add(ownerRegionId)
    const owner = regionsById.get(ownerRegionId)
    if (!owner) return null
    if (
      !displayRegionIds.has(owner.id) &&
      (owner.page !== candidate.page ||
        consumedRegionIds.has(owner.id) ||
        owner.lines.some((line) => reservedLineIds.has(line.id)) ||
        owner.kind !== 'equation' ||
        unresolvedMathExtensionGlyphFragment(owner) ||
        !hasDisplayEquationEvidence(owner, regions))
    ) {
      return null
    }
    if (!displayRegionIds.has(owner.id)) {
      clusterRegions.set(owner.id, owner)
    }
    for (const transitiveOwnerRegionId of sourceSequenceEquationOwnerRegionIds(
      owner,
      regions,
    )) {
      if (!visitedRegionIds.has(transitiveOwnerRegionId)) {
        pending.push(transitiveOwnerRegionId)
      }
    }
  }
  const orderedCluster = [...clusterRegions.values()].sort(
    (left, right) =>
      left.box.y - right.box.y ||
      left.box.x - right.box.x ||
      left.id.localeCompare(right.id),
  )
  if (
    orderedCluster.some(
      (region) =>
        region.page !== candidate.page ||
        consumedRegionIds.has(region.id) ||
        region.lines.some((line) => reservedLineIds.has(line.id)) ||
        region.kind !== 'equation' ||
        unresolvedMathExtensionGlyphFragment(region) ||
        !hasDisplayEquationEvidence(region, regions),
    )
  ) {
    return null
  }
  const combined = unionBox([...displayRegions, ...orderedCluster])
  if (combined.height > 0.12 || combined.width > MAX_DISPLAY_EQUATION_WIDTH) {
    return null
  }
  if (
    orderedCluster.some((owner) =>
      displayRegions.every((region) =>
        hasInterstitialEquationProseBoundary(region, owner, regions),
      ),
    )
  ) {
    return null
  }

  const growingComponent = [...displayRegions]
  const remaining = [
    candidate,
    ...orderedCluster.filter((region) => region.id !== candidate.id),
  ]
  while (remaining.length > 0) {
    const attachableIndex = remaining.findIndex((owner) =>
      growingComponent.some(
        (region) =>
          adjacentDisplayEquationRegion(region, owner, regions) &&
          !hasInterstitialEquationProseBoundary(region, owner, regions),
      ),
    )
    if (attachableIndex < 0) return null
    const owner = remaining[attachableIndex]
    if (
      !preservesPrintedEquationCardinality(growingComponent, owner, regions)
    ) {
      return null
    }
    growingComponent.push(owner)
    remaining.splice(attachableIndex, 1)
  }
  return orderedCluster
}

function attachedEquationRegions(
  source: PdfPageRegion,
  regions: PdfPageRegion[],
  consumedRegionIds: ReadonlySet<string>,
  reservedLineIds: ReadonlySet<string> = new Set(),
  proseSplitInlineFormulaBaseIds: ReadonlySet<string> = provedProseSplitInlineStackedFormulaBaseIds(
    regions,
  ),
) {
  const displayRegions = [source]
  let foundAdjacent = true
  while (foundAdjacent) {
    foundAdjacent = false
    for (const candidate of regions) {
      const ownedInlineFormulaBaseIds = new Set(
        displayRegions.flatMap((region) =>
          [...inlineStackedFormulaBaseIds(region)].filter((baseId) =>
            proseSplitInlineFormulaBaseIds.has(baseId),
          ),
        ),
      )
      const candidateInlineFormulaBaseIds = new Set(
        [...inlineStackedFormulaBaseIds(candidate)].filter((baseId) =>
          proseSplitInlineFormulaBaseIds.has(baseId),
        ),
      )
      const crossesInlineFormulaBoundary =
        (ownedInlineFormulaBaseIds.size > 0 ||
          candidateInlineFormulaBaseIds.size > 0) &&
        ![...candidateInlineFormulaBaseIds].some((baseId) =>
          ownedInlineFormulaBaseIds.has(baseId),
        )
      const sourceSequenceOwnerRegionIds = sourceSequenceEquationOwnerRegionIds(
        candidate,
        regions,
      )
      const candidateAlreadyAttached = displayRegions.some(
        (region) => region.id === candidate.id,
      )
      const linkedSourceSequenceOwner =
        sourceSequenceOwnerRegionIds.size > 0 &&
        displayRegions.some((region) =>
          sourceSequenceOwnerRegionIds.has(region.id),
        )
      // A stacked display can be painted as interleaved rows whose source
      // whitespace links point at one another (a radical column linked to its
      // radicand row) rather than at the seeding row. Such a mutually linked
      // cluster proves shared ownership only when every linked owner is itself
      // attachable to this component; ownership by a *different* display is
      // proved the moment the linked cluster escapes those bounds.
      const attachableSourceSequenceOwnerCluster =
        sourceSequenceOwnerRegionIds.size > 0 && !candidateAlreadyAttached
          ? componentAttachableSequenceOwnerCluster(
              candidate,
              sourceSequenceOwnerRegionIds,
              displayRegions,
              regions,
              consumedRegionIds,
              reservedLineIds,
            )
          : null
      const hasUnattachableSourceSequenceOwnerCluster =
        sourceSequenceOwnerRegionIds.size > 0 &&
        !candidateAlreadyAttached &&
        attachableSourceSequenceOwnerCluster === null
      if (
        candidate.id === source.id ||
        candidate.page !== source.page ||
        consumedRegionIds.has(candidate.id) ||
        candidate.lines.some((line) => reservedLineIds.has(line.id)) ||
        displayRegions.some((region) => region.id === candidate.id) ||
        (crossesInlineFormulaBoundary && !linkedSourceSequenceOwner) ||
        hasUnattachableSourceSequenceOwnerCluster ||
        candidate.kind !== 'equation' ||
        unresolvedMathExtensionGlyphFragment(candidate) ||
        !hasDisplayEquationEvidence(candidate, regions) ||
        !preservesPrintedEquationCardinality(
          displayRegions,
          candidate,
          regions,
        ) ||
        !displayRegions.some(
          (region) =>
            adjacentDisplayEquationRegion(region, candidate, regions) &&
            !hasInterstitialEquationProseBoundary(region, candidate, regions),
        )
      ) {
        continue
      }
      const regionsToAttach = attachableSourceSequenceOwnerCluster ?? [
        candidate,
      ]
      const combined = unionBox([...displayRegions, ...regionsToAttach])
      if (
        combined.height > 0.12 ||
        combined.width > MAX_DISPLAY_EQUATION_WIDTH
      ) {
        continue
      }
      displayRegions.push(...regionsToAttach)
      foundAdjacent = true
    }
  }
  const insideDisplayEnvelope = (
    candidate: PdfPageRegion,
    ownedRegions: readonly PdfPageRegion[],
  ) => {
    const displayBox = unionBox([...ownedRegions])
    const centerX = candidate.box.x + candidate.box.width / 2
    const centerY = candidate.box.y + candidate.box.height / 2
    return (
      centerX >= displayBox.x - 0.025 &&
      centerX <= displayBox.x + displayBox.width + 0.025 &&
      centerY >= displayBox.y - 0.025 &&
      centerY <= displayBox.y + displayBox.height + 0.025
    )
  }
  const displayDistance = (
    display: PdfPageRegion,
    candidate: PdfPageRegion,
  ) => {
    const gap = boxGap(display.box, candidate.box)
    const centerDistance = Math.hypot(
      display.box.x +
        display.box.width / 2 -
        (candidate.box.x + candidate.box.width / 2),
      display.box.y +
        display.box.height / 2 -
        (candidate.box.y + candidate.box.height / 2),
    )
    return gap.vertical * 2 + gap.horizontal + centerDistance * 0.1
  }
  const uniquelyOwnedByDisplay = (
    candidate: PdfPageRegion,
    ownedRegions: readonly PdfPageRegion[] = displayRegions,
  ) => {
    const ownedRegionIds = new Set(ownedRegions.map((region) => region.id))
    const ownedDistance = Math.min(
      ...ownedRegions.map((region) => displayDistance(region, candidate)),
    )
    const competingDistances = regions
      .filter(
        (region) =>
          region.id !== candidate.id &&
          region.page === candidate.page &&
          !consumedRegionIds.has(region.id) &&
          region.kind === 'equation' &&
          hasDisplayEquationEvidence(region, regions) &&
          !ownedRegionIds.has(region.id),
      )
      .map((region) => displayDistance(region, candidate))
    return (
      competingDistances.length === 0 ||
      ownedDistance + 0.002 < Math.min(...competingDistances)
    )
  }
  const attachedFragments: PdfPageRegion[] = []
  const attachedRegionIds = new Set(displayRegions.map((region) => region.id))
  let foundFragment = true
  while (foundFragment) {
    foundFragment = false
    for (const candidate of regions) {
      const mathExtensionFragment = mathExtensionGlyphFragment(candidate)
      const mathExtensionScaffold =
        sourceMathExtensionScaffoldFragment(candidate)
      const sourceMathGlyphFragment = sourceMathFragment(candidate)
      const sourceMathFontContinuation =
        sourceMathFontOnlyContinuation(candidate)
      const numericAssignmentFragment = numericListAssignmentFragment(candidate)
      const contextualMathOperatorFragment =
        contextualStixMathOperatorFragment(candidate)
      const sourceMathOperator = sourceMathOperatorFragment(candidate)
      const sourceUprightMathOperator =
        sourceUprightMathOperatorContinuation(candidate)
      const attachableFragmentKind =
        ['body', 'spanning', 'side', 'chart-label', 'page-number'].includes(
          candidate.kind,
        ) || candidate.kind === 'equation'
      const wholeFragmentAvailable = candidate.lines.every(
        (line) => !reservedLineIds.has(line.id),
      )
      const ownedInlineFormulaBaseIds = new Set(
        displayRegions.flatMap((region) =>
          [...inlineStackedFormulaBaseIds(region)].filter((baseId) =>
            proseSplitInlineFormulaBaseIds.has(baseId),
          ),
        ),
      )
      const candidateInlineFormulaBaseIds = new Set(
        [...inlineStackedFormulaBaseIds(candidate)].filter((baseId) =>
          proseSplitInlineFormulaBaseIds.has(baseId),
        ),
      )
      const belongsToAnotherInlineFormula =
        candidateInlineFormulaBaseIds.size > 0 &&
        ![...candidateInlineFormulaBaseIds].some((baseId) =>
          ownedInlineFormulaBaseIds.has(baseId),
        )
      const detachedHostLineIds = new Set(
        candidate.lines.flatMap((line) => {
          const hostLineId = detachedMathHostLineId(line.id)
          return hostLineId ? [hostLineId] : []
        }),
      )
      const unresolvedDetachedHost = unresolvedDetachedMathHost(candidate)
      const ownedRegions = [...displayRegions, ...attachedFragments]
      const ownedLineIds = new Set(
        ownedRegions.flatMap((region) => region.lines.map((line) => line.id)),
      )
      const belongsToAnotherDetachedHost =
        detachedHostLineIds.size > 0 &&
        ![...detachedHostLineIds].every((lineId) => ownedLineIds.has(lineId))
      const sourceSequenceOwnerRegionIds = sourceSequenceEquationOwnerRegionIds(
        candidate,
        regions,
      )
      const linkedSourceSequenceOwner =
        sourceSequenceOwnerRegionIds.size > 0 &&
        ownedRegions.some((region) =>
          sourceSequenceOwnerRegionIds.has(region.id),
        )
      const belongsToAnotherSourceSequenceOwner =
        sourceSequenceOwnerRegionIds.size > 0 && !linkedSourceSequenceOwner
      if (
        attachedRegionIds.has(candidate.id) ||
        candidate.page !== source.page ||
        consumedRegionIds.has(candidate.id) ||
        (belongsToAnotherInlineFormula && !linkedSourceSequenceOwner) ||
        belongsToAnotherDetachedHost ||
        belongsToAnotherSourceSequenceOwner ||
        unresolvedDetachedHost ||
        !attachableFragmentKind
      ) {
        continue
      }
      const contextualRomanScript = contextualSourceRomanScriptFragment(
        candidate,
        ownedRegions,
      )
      const contextualNeutralVerticalEllipsis =
        contextualNeutralVerticalEllipsisFragment(candidate, ownedRegions)
      let fragment: PdfPageRegion | null = null
      if (
        wholeFragmentAvailable &&
        (mathExtensionFragment ||
          mathExtensionScaffold ||
          sourceMathGlyphFragment ||
          sourceMathFontContinuation ||
          numericAssignmentFragment ||
          contextualMathOperatorFragment ||
          sourceMathOperator ||
          sourceUprightMathOperator ||
          contextualRomanScript ||
          contextualNeutralVerticalEllipsis)
      ) {
        fragment = candidate
      } else {
        const selectedMathLines = candidate.lines.filter((line) => {
          if (reservedLineIds.has(line.id)) return false
          const lineFragment = {
            ...candidate,
            text: line.text,
            box: line.box,
            lines: [line],
          }
          return (
            mathExtensionGlyphFragment(lineFragment) ||
            sourceMathExtensionScaffoldFragment(lineFragment) ||
            contextualNeutralVerticalEllipsisFragment(
              lineFragment,
              ownedRegions,
            ) ||
            sourceMathFragment(lineFragment) ||
            sourceMathFontOnlyContinuation(lineFragment) ||
            sourceMathOperatorFragment(lineFragment) ||
            numericListAssignmentFragment(lineFragment) ||
            bareNumericMathFragment(lineFragment) ||
            printedEquationNumberFragment(lineFragment)
          )
        })
        if (selectedMathLines.length > 0) {
          fragment = {
            ...candidate,
            text: selectedMathLines.map((line) => line.text).join(' '),
            box: boxForLines(selectedMathLines),
            lines: selectedMathLines,
          }
        }
      }
      const linkedInlineMathSibling =
        fragment !== null &&
        fragment.lines.length > 0 &&
        fragment.lines.every((line) => {
          const baseId = inlineStackedSiblingBaseId(line.id)
          return baseId !== null && ownedInlineFormulaBaseIds.has(baseId)
        })
      const linkedDetachedMathHost =
        fragment !== null &&
        detachedHostLineIds.size > 0 &&
        [...detachedHostLineIds].every((lineId) => ownedLineIds.has(lineId))
      const displayScope = {
        ...source,
        box: unionBox(ownedRegions),
      }
      const sourceOwnedFragment =
        fragment !== null &&
        insideDisplayEnvelope(fragment, ownedRegions) &&
        uniquelyOwnedByDisplay(fragment, ownedRegions)
      const compactFragment =
        wholeFragmentAvailable && compactEquationFragment(candidate)
      const sourceProvedInlineFormula =
        wholeFragmentAvailable &&
        sourceProvedInlineStackedMathFormula(candidate)
      const gap = boxGap(displayScope.box, candidate.box)
      const adjacentCompactFragment =
        compactFragment &&
        (printedEquationNumberFragment(candidate) ||
          uniquelyOwnedByDisplay(candidate, ownedRegions)) &&
        (alignedPrintedEquationNumber(displayScope, candidate) ||
          ownedRegions.some((region) =>
            alignedPrintedEquationNumber(region, candidate),
          ) ||
          ownedRegions.some((region) => {
            const regionGap = boxGap(region.box, candidate.box)
            return regionGap.horizontal <= 0.01 && regionGap.vertical <= 0.012
          }) ||
          (gap.horizontal <= 0.01 && gap.vertical <= 0.012))
      const adjacentSourceMathFontContinuation =
        fragment !== null &&
        sourceMathFontContinuation &&
        uniquelyOwnedByDisplay(fragment, ownedRegions) &&
        ownedRegions.some((region) => {
          const regionGap = boxGap(region.box, fragment!.box)
          return regionGap.horizontal <= 0.02 && regionGap.vertical <= 0.012
        })
      const selected = linkedDetachedMathHost
        ? fragment
        : linkedSourceSequenceOwner
          ? (fragment ??
            (sourceProvedInlineFormula || compactFragment ? candidate : null))
          : linkedInlineMathSibling
            ? fragment
            : sourceOwnedFragment
              ? fragment
              : adjacentSourceMathFontContinuation
                ? fragment
                : adjacentCompactFragment
                  ? candidate
                  : null
      const bypassesDisplayAdjacencyGuards =
        selected !== null &&
        !linkedDetachedMathHost &&
        !linkedSourceSequenceOwner &&
        !linkedInlineMathSibling &&
        hasDisplayEquationEvidence(selected, regions) &&
        displayRegions.some((display) =>
          hasInterstitialEquationProseBoundary(display, selected, regions),
        )
      if (
        !selected ||
        bypassesDisplayAdjacencyGuards ||
        !preservesPrintedEquationCardinality(displayRegions, selected, regions)
      ) {
        continue
      }
      const combined = unionBox([...ownedRegions, selected])
      if (
        combined.height > 0.12 ||
        combined.width > MAX_DISPLAY_EQUATION_WIDTH
      ) {
        continue
      }
      attachedFragments.push(selected)
      attachedRegionIds.add(selected.id)
      foundFragment = true
    }
  }
  return [...displayRegions, ...attachedFragments].sort(
    (left, right) =>
      left.box.y - right.box.y ||
      left.box.x - right.box.x ||
      left.id.localeCompare(right.id),
  )
}

interface DisplayEquationComponent {
  source: PdfPageRegion
  regions: PdfPageRegion[]
}

interface EquationComponentOwnership {
  sourceRegionIds: string[]
  sourceLineIds: string[]
}

function proveEquationComponentOwnership(
  sources: readonly PdfPageRegion[],
  allRegions: readonly PdfPageRegion[],
): EquationComponentOwnership | null {
  const sourceRegionIds = sources.map((source) => source.id)
  const sourceLineIds = sources.flatMap((source) =>
    source.lines.map((line) => line.id),
  )
  if (
    sourceRegionIds.length === 0 ||
    sourceLineIds.length === 0 ||
    new Set(sourceRegionIds).size !== sourceRegionIds.length ||
    new Set(sourceLineIds).size !== sourceLineIds.length
  ) {
    return null
  }
  const sourceLineIdSet = new Set(sourceLineIds)
  const inlineFormulaBaseIds = new Set(
    sourceLineIds.flatMap((lineId) => {
      const match = /^(.*-inline-stacked-\d+)-formula$/u.exec(lineId)
      return match ? [match[1]] : []
    }),
  )
  const unsafeInlineSibling = allRegions.some(
    (region) =>
      region.kind !== 'body' &&
      region.lines.some((line) => {
        if (sourceLineIdSet.has(line.id)) return false
        const match = /^(.*-inline-stacked-\d+)-(before|after)$/u.exec(line.id)
        return Boolean(match && inlineFormulaBaseIds.has(match[1]))
      }),
  )
  if (unsafeInlineSibling) return null
  const sourceRunOwnershipKeys = sources.flatMap((source) =>
    source.lines.flatMap((line) =>
      line.runs
        .filter((run) => run.text.trim())
        .map(equationSourceRunOwnershipKey),
    ),
  )
  if (
    sourceRunOwnershipKeys.length === 0 ||
    new Set(sourceRunOwnershipKeys).size !== sourceRunOwnershipKeys.length
  ) {
    return null
  }

  const regionOccurrenceCount = new Map<string, number>()
  const lineOccurrenceCount = new Map<string, number>()
  const regionLineOccurrenceCount = new Map<string, number>()
  const runOccurrenceCount = new Map<string, number>()
  for (const region of allRegions) {
    regionOccurrenceCount.set(
      region.id,
      (regionOccurrenceCount.get(region.id) ?? 0) + 1,
    )
    for (const line of region.lines) {
      lineOccurrenceCount.set(
        line.id,
        (lineOccurrenceCount.get(line.id) ?? 0) + 1,
      )
      const regionLineKey = `${region.id}\u001f${line.id}`
      regionLineOccurrenceCount.set(
        regionLineKey,
        (regionLineOccurrenceCount.get(regionLineKey) ?? 0) + 1,
      )
      for (const run of line.runs.filter((candidate) =>
        candidate.text.trim(),
      )) {
        const key = equationSourceRunOwnershipKey(run)
        runOccurrenceCount.set(key, (runOccurrenceCount.get(key) ?? 0) + 1)
      }
    }
  }
  if (
    sourceRegionIds.some(
      (regionId) => regionOccurrenceCount.get(regionId) !== 1,
    ) ||
    sources.some((source) =>
      source.lines.some(
        (line) =>
          lineOccurrenceCount.get(line.id) !== 1 ||
          regionLineOccurrenceCount.get(`${source.id}\u001f${line.id}`) !== 1,
      ),
    ) ||
    sourceRunOwnershipKeys.some((key) => runOccurrenceCount.get(key) !== 1)
  ) {
    return null
  }
  return { sourceRegionIds, sourceLineIds }
}

async function displayEquationComponents(
  regions: PdfPageRegion[],
  consumedRegionIds: ReadonlySet<string>,
  onProgress?: (progress: PdfImportProgress) => void,
  signal?: AbortSignal,
) {
  splitSourceProvedAnswerCueEquations(regions, consumedRegionIds)
  const sourceOrder = (left: PdfPageRegion, right: PdfPageRegion) =>
    left.page - right.page ||
    left.box.y - right.box.y ||
    left.box.x - right.box.x ||
    left.id.localeCompare(right.id)
  const orderedRegions = [...regions].sort(sourceOrder)
  onProgress?.({
    phase: 'semantic-promotion',
    completed: 0,
    total: orderedRegions.length,
    message: `Indexing display-equation evidence across ${orderedRegions.length} source regions…`,
    checkpoint: 'equation-component-discovery',
  })
  await yieldPdfVisualTask(signal)
  const proseSplitInlineFormulaBaseIds =
    provedProseSplitInlineStackedFormulaBaseIds(orderedRegions)
  const regionsByPage = new Map<number, PdfPageRegion[]>()
  for (const region of orderedRegions) {
    const pageRegions = regionsByPage.get(region.page) ?? []
    pageRegions.push(region)
    regionsByPage.set(region.page, pageRegions)
  }
  const displaySources: PdfPageRegion[] = []
  for (const [regionIndex, region] of orderedRegions.entries()) {
    if (
      !consumedRegionIds.has(region.id) &&
      hasDisplayEquationEvidence(region, regionsByPage.get(region.page) ?? [])
    ) {
      displaySources.push(region)
    }
    const completed = regionIndex + 1
    if (
      completed % PDF_VISUAL_INDEX_COOPERATIVE_BATCH_SIZE === 0 ||
      completed === orderedRegions.length
    ) {
      onProgress?.({
        phase: 'semantic-promotion',
        completed,
        total: orderedRegions.length,
        message: `Indexed display-equation evidence for ${completed} of ${orderedRegions.length} source regions…`,
        checkpoint: 'equation-component-discovery',
      })
      await yieldPdfVisualTask(signal)
    }
  }
  const displaySourcePageRegions = new Map(
    displaySources.map((source) => [
      source.id,
      regionsByPage.get(source.page) ?? [],
    ]),
  )
  const ownedLineIds = new Set<string>()
  const components: DisplayEquationComponent[] = []

  for (const [sourceIndex, source] of displaySources.entries()) {
    if (
      sourceIndex > 0 &&
      sourceIndex % PDF_VISUAL_COOPERATIVE_BATCH_SIZE === 0
    ) {
      onProgress?.({
        phase: 'semantic-promotion',
        completed: sourceIndex,
        total: displaySources.length,
        message: `Examined ${sourceIndex} of ${displaySources.length} display-equation source candidates…`,
        checkpoint: 'equation-component-resolution',
      })
      await yieldPdfVisualTask(signal)
    }
    if (source.lines.some((line) => ownedLineIds.has(line.id))) continue
    const pageRegions = displaySourcePageRegions.get(source.id) ?? []
    const componentRegions = attachedEquationRegions(
      source,
      pageRegions,
      consumedRegionIds,
      ownedLineIds,
      proseSplitInlineFormulaBaseIds,
    )
    // Only a region with display-level evidence can seed a component. Source
    // math fragments, operators, scripts, and printed numbers may extend that
    // component, but can never promote themselves as singleton displays.
    if (
      !componentRegions.some(
        (region) =>
          region.id === source.id &&
          hasDisplayEquationEvidence(region, pageRegions),
      )
    ) {
      continue
    }
    for (const region of componentRegions) {
      for (const line of region.lines) ownedLineIds.add(line.id)
    }
    const primarySource =
      componentRegions.find(
        (region) =>
          region.kind === 'equation' &&
          region.includedInReadingOrder &&
          !unresolvedMathExtensionGlyphFragment(region) &&
          (hasDisplayEquationEvidence(region, pageRegions) ||
            sourceMathOperatorFragment(region)),
      ) ??
      componentRegions.find(
        (region) =>
          region.kind === 'equation' &&
          hasDisplayEquationEvidence(region, pageRegions) &&
          !unresolvedMathExtensionGlyphFragment(region),
      ) ??
      source
    components.push({ source: primarySource, regions: componentRegions })
  }
  if (displaySources.length > 0) {
    onProgress?.({
      phase: 'semantic-promotion',
      completed: displaySources.length,
      total: displaySources.length,
      message: `Examined ${displaySources.length} of ${displaySources.length} display-equation source candidates…`,
      checkpoint: 'equation-component-resolution',
    })
    await yieldPdfVisualTask(signal)
  }

  return components.sort((left, right) => {
    const leftBox = unionBox(left.regions)
    const rightBox = unionBox(right.regions)
    return (
      leftBox.page - rightBox.page ||
      leftBox.y - rightBox.y ||
      leftBox.x - rightBox.x ||
      left.source.id.localeCompare(right.source.id)
    )
  })
}

function completeEquationSourceScope(
  sources: readonly PdfPageRegion[],
  regions: readonly PdfPageRegion[],
  consumedRegionIds: ReadonlySet<string>,
  examinedEquationRegionIds: ReadonlySet<string>,
) {
  const sourceLineIds = sources.flatMap((source) =>
    source.lines.map((line) => line.id),
  )
  const sourceLineIdSet = new Set(sourceLineIds)
  const inlineFormulaBaseIds = new Set(
    sourceLineIds.flatMap((lineId) => {
      const match = /^(.*-inline-stacked-\d+)-formula$/u.exec(lineId)
      return match ? [match[1]] : []
    }),
  )
  const inlineSiblingRegions = regions.filter((region) =>
    region.lines.some((line) => {
      if (sourceLineIdSet.has(line.id)) return false
      const match = /^(.*-inline-stacked-\d+)-(before|after)$/u.exec(line.id)
      return Boolean(match && inlineFormulaBaseIds.has(match[1]))
    }),
  )
  if (
    inlineFormulaBaseIds.size > 0 &&
    inlineSiblingRegions.length > 0 &&
    !hasAmbiguousStackedEquationGeometry([...sources])
  ) {
    return false
  }
  const isOwnedInlineSiblingRegion = (region: PdfPageRegion) =>
    region.kind === 'body' &&
    region.lines.some((line) => {
      const match = /^(.*-inline-stacked-\d+)-(before|after)$/u.exec(line.id)
      return Boolean(match && inlineFormulaBaseIds.has(match[1]))
    })
  const sourceIds = new Set(sources.map((source) => source.id))
  const printedNumbers = new Set(
    sources.flatMap((source) => {
      const number = sourcePrintedEquationNumber(source)
      return number === null ? [] : [number.toLocaleLowerCase()]
    }),
  )
  const envelope = unionBox([...sources])
  const insideNearbyEnvelope = (candidate: PdfPageRegion) => {
    const centerX = candidate.box.x + candidate.box.width / 2
    const centerY = candidate.box.y + candidate.box.height / 2
    return (
      centerX >= envelope.x - 0.025 &&
      centerX <= envelope.x + envelope.width + 0.025 &&
      centerY >= envelope.y - 0.025 &&
      centerY <= envelope.y + envelope.height + 0.025
    )
  }
  const displayDistance = (
    display: PdfPageRegion,
    candidate: PdfPageRegion,
  ) => {
    const gap = boxGap(display.box, candidate.box)
    const centerDistance = Math.hypot(
      display.box.x +
        display.box.width / 2 -
        (candidate.box.x + candidate.box.width / 2),
      display.box.y +
        display.box.height / 2 -
        (candidate.box.y + candidate.box.height / 2),
    )
    return gap.vertical * 2 + gap.horizontal + centerDistance * 0.1
  }
  return !regions.some((candidate) => {
    if (
      sourceIds.has(candidate.id) ||
      consumedRegionIds.has(candidate.id) ||
      candidate.page !== envelope.page
    ) {
      return false
    }
    const candidateNumber = sourcePrintedEquationNumber(candidate)
    if (
      candidateNumber !== null &&
      printedNumbers.size > 0 &&
      !printedNumbers.has(candidateNumber.toLocaleLowerCase())
    ) {
      return false
    }
    // The region splitter deliberately keeps the prose before and after a
    // two-dimensional inline formula as body text. Those sibling fragments
    // prove the formula's source-line position; they do not make the formula
    // crop incomplete. Crop bounding and unowned-text checks below still keep
    // pixels from either prose sibling out of the equation asset.
    if (isOwnedInlineSiblingRegion(candidate)) return false
    const adjacentSameLineContinuation = sources.some((source) => {
      if (
        source.page !== candidate.page ||
        source.box.rotation !== candidate.box.rotation ||
        printedEquationNumberFragment(candidate)
      ) {
        return false
      }
      const verticalOverlap = verticalBoxOverlap(source.box, candidate.box)
      const minimumHeight = Math.min(source.box.height, candidate.box.height)
      if (
        minimumHeight <= 0 ||
        verticalOverlap < minimumHeight * 0.35 ||
        boxGap(source.box, candidate.box).horizontal > 0.015
      ) {
        return false
      }
      const left =
        source.box.x <= candidate.box.x
          ? { region: source, text: source.text.trimEnd() }
          : { region: candidate, text: candidate.text.trimEnd() }
      const right =
        left.region.id === source.id
          ? candidate.text.trimStart()
          : source.text.trimStart()
      return (
        /[=+\-−×÷≤≥≈∼⊙∂∞∏∈∉→←([{,]$/u.test(left.text) ||
        /^[=+\-−×÷≤≥≈∼⊙∂∞∏∈∉→←)\]},]/u.test(right)
      )
    })
    if (adjacentSameLineContinuation) return true
    if (
      candidate.kind === 'equation' &&
      examinedEquationRegionIds.has(candidate.id)
    ) {
      return false
    }
    const mathExtensionFragment = mathExtensionGlyphFragment(candidate)
    const mathExtensionScaffold = sourceMathExtensionScaffoldFragment(candidate)
    const sourceMathGlyphFragment = sourceMathFragment(candidate)
    const sourceMathFontContinuation = sourceMathFontOnlyContinuation(candidate)
    const numericAssignmentFragment = numericListAssignmentFragment(candidate)
    const formulaFragment =
      (candidate.kind === 'equation' &&
        hasDisplayEquationEvidence(candidate, regions)) ||
      mathExtensionFragment ||
      mathExtensionScaffold ||
      contextualNeutralVerticalEllipsisFragment(candidate, sources) ||
      sourceMathGlyphFragment ||
      sourceMathFontContinuation ||
      sourceMathOperatorFragment(candidate) ||
      numericAssignmentFragment ||
      compactEquationFragment(candidate) ||
      printedEquationNumberFragment(candidate)
    if (!formulaFragment) return false
    const independentDisplay =
      candidate.kind === 'equation' &&
      !mathExtensionFragment &&
      !sourceMathGlyphFragment
    if (independentDisplay) {
      return sources.some((source) =>
        adjacentDisplayEquationRegion(source, candidate, regions),
      )
    }
    if (!insideNearbyEnvelope(candidate)) return false
    const ownedDistance = Math.min(
      ...sources.map((source) => displayDistance(source, candidate)),
    )
    const competingDistances = regions
      .filter(
        (region) =>
          region.id !== candidate.id &&
          region.page === candidate.page &&
          !sourceIds.has(region.id) &&
          !consumedRegionIds.has(region.id) &&
          region.kind === 'equation' &&
          !mathExtensionGlyphFragment(region) &&
          hasDisplayEquationEvidence(region, regions),
      )
      .map((region) => displayDistance(region, candidate))
    return (
      competingDistances.length === 0 ||
      Math.min(...competingDistances) + 0.002 >= ownedDistance
    )
  })
}

function consumeRegionLineSelection(
  regionId: string,
  selectedLineIds: readonly string[],
  regions: readonly PdfPageRegion[],
  consumedRegionIds: Set<string>,
  consumedLineIds: Set<string>,
) {
  const original = regions.find((region) => region.id === regionId)
  if (
    !original ||
    original.lines.length === 0 ||
    selectedLineIds.length === 0
  ) {
    consumedRegionIds.add(regionId)
    return
  }
  const selected = new Set(selectedLineIds)
  if (original.lines.every((line) => selected.has(line.id))) {
    consumedRegionIds.add(regionId)
    return
  }
  for (const line of original.lines) {
    if (selected.has(line.id)) consumedLineIds.add(line.id)
  }
}

function sourceEquationLabel(
  region: PdfPageRegion,
  pageSequence: number,
  sources: PdfPageRegion[],
) {
  const printedNumber = sources
    .map(sourcePrintedEquationNumber)
    .find((value) => value !== null)
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
  rasterizeFigure: suppliedRasterizeFigure,
  tableCandidateProvider,
  allowRemoteTableCandidateProvider = false,
  onProgress,
  signal,
}: {
  pages: PdfPageAnalysis[]
  regions: PdfPageRegion[]
  rasterizeFigure?: PdfFigureRasterizer
  tableCandidateProvider?: TableCandidateProvider
  allowRemoteTableCandidateProvider?: boolean
  onProgress?: (progress: PdfImportProgress) => void
  signal?: AbortSignal
}) {
  throwIfPdfVisualWorkAborted(signal)
  const rasterizeFigure = suppliedRasterizeFigure
    ? withSourceCropAttemptProvenance(suppliedRasterizeFigure)
    : undefined
  const diagnostics: ReconstructionDiagnostic[] = []
  const tableCandidateReceipts: TableCandidateReceipt[] = []
  let remoteTableCandidateUsed = false
  const unresolvedExtensionTextItemKeys = new Set<string>()
  const unresolvedExtensionTextItems: PdfSourceRun[] = []
  for (const page of pages) {
    for (const run of page.renderVisibleTextRuns ?? []) {
      if (
        run.text !== '\ufffd' ||
        sourceMathFontProvenance(run.fontName)?.role !== 'math-extension' ||
        run.sourceTextPaint
      ) {
        continue
      }
      const key = [
        run.page,
        run.sourceSequenceIndex ?? 'unsequenced',
        run.x,
        run.y,
        run.width,
        run.height,
      ].join(':')
      if (unresolvedExtensionTextItemKeys.has(key)) continue
      unresolvedExtensionTextItemKeys.add(key)
      unresolvedExtensionTextItems.push(run)
    }
  }
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
  const objectKinds = new Map(
    pages
      .flatMap((page) => page.objects ?? [])
      .map((object) => [object.id, object.kind] as const),
  )
  const lineageBoxes = new Map([
    ...objectBoxes,
    ...regions
      .filter((region) => region.lines.length > 0 && region.text.trim())
      .map((region) => [textOverlayId(region), region.box] as const),
  ])
  const nativeObjectCount = pages.reduce(
    (total, page) => total + (page.objects?.length ?? 0),
    0,
  )
  onProgress?.({
    phase: 'semantic-promotion',
    completed: 0,
    total: 4,
    message: `Indexing ${nativeObjectCount} native visual objects for bounded classification…`,
    checkpoint: 'visual-index',
  })
  const rectangleIndexEvidence: PdfRectangleIndexEvidence = {
    candidateComparisons: 0,
  }
  const repeatedRectangleObjectIds = repeatedRectangleFallbackObjectIds(
    pages,
    rectangleIndexEvidence,
  )
  const decorativeObjectIds = decorativeNativeObjectIds(
    pages,
    repeatedRectangleObjectIds,
  )
  const pageBackdropObjectIds = reusedPageBackdropObjectIds(
    pages,
    repeatedRectangleObjectIds,
  )
  const panelClipObjectIds = reusedPanelClipObjectIds(
    pages,
    repeatedRectangleObjectIds,
  )
  onProgress?.({
    phase: 'semantic-promotion',
    completed: 1,
    total: 4,
    message: `Indexed native visuals with ${rectangleIndexEvidence.candidateComparisons} bounded rectangle comparisons…`,
    checkpoint: 'visual-index-complete',
  })
  // Region classification is part of the caption evidence. Looking only at the
  // leading text turns sentences such as "Table 5 shows ..." into invented
  // visual relationships when they occur at the start of a paragraph.
  const captionLabels = new Map(
    regions.flatMap((region) => {
      const firstRun = region.lines
        .flatMap((line) => line.runs)
        .find((run) => run.text.trim())
      const dedicatedLabelStyle = Boolean(
        firstRun && dedicatedCaptionLabelStyle(firstRun),
      )
      const label =
        parsePdfScholarlyVisualLabel(region.text, {
          context: 'caption',
        }) ??
        (dedicatedLabelStyle
          ? parsePdfScholarlyVisualLabel(region.text, {
              context: 'reference',
            })
          : null)
      return label ? ([[region, label]] as const) : []
    }),
  )
  const preformattedDetection = boundedPreformattedBlocks(
    pages,
    regions,
    preformattedScopeReservations(pages, regions, captionLabels),
  )
  const preformattedBlocks = preformattedDetection.blocks
  for (const unresolved of preformattedDetection.unresolved) {
    diagnostics.push({
      code: 'UNRESOLVED_PREFORMATTED_BLOCK',
      severity: 'warning',
      page: unresolved.page,
      message:
        'A source run has preformatted font or indentation evidence, but no unique attached caption or introducer proves its complete scope; it remains prose.',
      sourceBoxes: unresolved.sourceBoxes,
      target: { regionIds: unresolved.regionIds, markerId: null },
    })
  }
  const preformattedCaptionRegionIds = new Set(
    preformattedBlocks.map((block) => block.caption.id),
  )
  const captions = regions.filter((region) => {
    const firstRun = region.lines
      .flatMap((line) => line.runs)
      .find((run) => run.text.trim())
    return (
      (region.kind === 'caption' ||
        Boolean(firstRun && dedicatedCaptionLabelStyle(firstRun))) &&
      captionLabels.has(region) &&
      !preformattedCaptionRegionIds.has(region.id) &&
      !unstyledProseTableReference(region)
    )
  })
  for (const caption of captions) {
    caption.kind = 'caption'
    // A caption can initially be classified as chart/side text because it
    // touches the visual envelope. Once the caption detector has proved its
    // semantic label and dedicated caption role, it must re-enter canonical
    // reading order so the atomic visual can retain a real caption node.
    caption.includedInReadingOrder = true
  }
  const figureCaptions = captions.filter(
    (caption) => captionLabels.get(caption)?.kind === 'figure',
  )
  onProgress?.({
    phase: 'semantic-promotion',
    completed: 2,
    total: 4,
    message: `Grouping bounded figure candidates across ${regions.length} regions and ${captions.length} typed captions…`,
    checkpoint: 'figure-grouping',
  })
  await yieldPdfVisualTask(signal)
  const figureGroupingEvidence: PdfFigureGroupingEvidence = {
    figureRegionCount: 0,
    retainedFigureRegionCount: 0,
    connectivityComparisons: 0,
    groupCount: 0,
  }
  const rawFigures = (
    await figureCandidates(
      regions,
      figureCaptions,
      decorativeObjectIds,
      pageBackdropObjectIds,
      panelClipObjectIds,
      figureGroupingEvidence,
      onProgress,
      signal,
    )
  ).map((candidate) => ({
    ...candidate,
    assetIds: candidate.sourceObjectIds
      .map((id) => objectAssetIds.get(id))
      .filter((id): id is string => Boolean(id)),
  }))
  const matchedStrongFigures = new Set<VisualCandidate>()
  const strongFigureOwnerClaims = new Map<VisualCandidate, Set<string>>()
  const strongFigureSourceOwnerClaims = new Map<string, Set<string>>()
  for (const caption of figureCaptions) {
    const captionLabel = captionLabels.get(caption)
    if (
      !captionLabel ||
      captionLabel.status === 'unparseable' ||
      captionLabel.kind !== 'figure'
    ) {
      continue
    }
    const label: ParsedPdfScholarlyVisualLabel & { sequence: string } = {
      ...captionLabel,
      sequence: captionLabel.identifier,
    }
    const result = matchCandidate(caption, label, rawFigures, regions)
    for (const scored of result.scored) {
      if (
        scored.score < 0.72 ||
        (!scored.candidate.evidence?.includes(
          'caption-bounded-native-scaffold',
        ) &&
          !connectedFigureReservationLineage(scored.candidate, regions))
      ) {
        continue
      }
      const owners =
        strongFigureOwnerClaims.get(scored.candidate) ?? new Set<string>()
      owners.add(caption.id)
      strongFigureOwnerClaims.set(scored.candidate, owners)
      for (const sourceKey of strongFigureOwnershipKeys(
        scored.candidate,
        regions,
      )) {
        const sourceOwners =
          strongFigureSourceOwnerClaims.get(sourceKey) ?? new Set<string>()
        sourceOwners.add(caption.id)
        strongFigureSourceOwnerClaims.set(sourceKey, sourceOwners)
      }
    }
    const candidate = result.best?.candidate
    if (
      !result.matched ||
      !candidate ||
      (!candidate.evidence?.includes('caption-bounded-native-scaffold') &&
        !connectedFigureReservationLineage(candidate, regions))
    ) {
      continue
    }
    matchedStrongFigures.add(candidate)
  }
  const uniqueStrongFigureOwnerByRawCandidate = new Map<
    VisualCandidate,
    string
  >()
  for (const candidate of matchedStrongFigures) {
    const owners = strongFigureOwnerClaims.get(candidate)
    const owner = owners?.size === 1 ? [...owners][0] : undefined
    const sourceKeys = strongFigureOwnershipKeys(candidate, regions)
    if (
      !owner ||
      sourceKeys.some((sourceKey) => {
        const sourceOwners = strongFigureSourceOwnerClaims.get(sourceKey)
        return sourceOwners?.size !== 1 || !sourceOwners.has(owner)
      })
    ) {
      continue
    }
    const ownerCaption = figureCaptions.find((caption) => caption.id === owner)
    if (
      ownerCaption &&
      connectedFigureReservationContestedByTableCaption(
        candidate,
        ownerCaption,
        captions,
        regions,
        captionLabels,
      )
    ) {
      continue
    }
    uniqueStrongFigureOwnerByRawCandidate.set(candidate, owner)
  }
  const figures = rawFigures.map((candidate) => {
    if (!uniqueStrongFigureOwnerByRawCandidate.has(candidate)) return candidate
    return candidate.evidence?.includes('caption-bounded-native-scaffold')
      ? trimStrongFigureCandidateOverlays(candidate, regions)
      : retainConnectedFigureReservationLineage(candidate, regions)
  })
  const uniqueStrongFigureOwnerByCandidate = new Map<VisualCandidate, string>()
  for (const [index, candidate] of figures.entries()) {
    const owner = uniqueStrongFigureOwnerByRawCandidate.get(rawFigures[index])
    if (owner) uniqueStrongFigureOwnerByCandidate.set(candidate, owner)
  }
  const reservedFigureLineIds = new Set(
    figures
      .filter((_, index) =>
        uniqueStrongFigureOwnerByRawCandidate.has(rawFigures[index]),
      )
      .flatMap((candidate) =>
        preTableFigureReservationOverlayLineage(candidate, regions).flatMap(
          (overlay) => overlay.lineIds,
        ),
      ),
  )
  const reservedFigureSourceObjectIds = new Set(
    figures
      .filter((_, index) =>
        uniqueStrongFigureOwnerByRawCandidate.has(rawFigures[index]),
      )
      .flatMap((candidate) =>
        candidate.sourceObjectIds.filter(
          (sourceObjectId) => !sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX),
        ),
      ),
  )
  throwIfPdfVisualWorkAborted(signal)
  onProgress?.({
    phase: 'semantic-promotion',
    completed: 3,
    total: 4,
    message: `Validating ${figures.length} bounded figure candidates from ${figureGroupingEvidence.groupCount} groups after retaining ${figureGroupingEvidence.retainedFigureRegionCount} of ${figureGroupingEvidence.figureRegionCount} visual regions and ${figureGroupingEvidence.connectivityComparisons} local comparisons…`,
    checkpoint: 'figure-grouping-complete',
  })
  await yieldPdfVisualTask(signal)
  const consumedRegionIds = new Set<string>()
  const consumedLineIds = new Set<string>()
  const consumedSourceObjectIds = new Set<string>()
  const consumedSourceObjectScopes = new Map<string, NormalizedSourceBox[]>()
  const relationships: PdfVisualRelationship[] = []

  for (const [captionIndex, caption] of captions.entries()) {
    if (
      captionIndex > 0 &&
      captionIndex % PDF_VISUAL_COOPERATIVE_BATCH_SIZE === 0
    ) {
      onProgress?.({
        phase: 'semantic-promotion',
        completed: captionIndex,
        total: captions.length,
        message: `Resolving typed visual captions ${captionIndex} of ${captions.length}…`,
      })
      await yieldPdfVisualTask(signal)
    }
    const captionLabel = captionLabels.get(caption)!
    if (captionLabel.status === 'unparseable') {
      const evidence = ['unparseable-scholarly-label']
      diagnostics.push({
        code: 'UNRESOLVED_VISUAL_OBJECT',
        severity: 'error',
        page: caption.page,
        message: `${captionLabel.label} has an explicit source caption but no bounded scholarly identifier.`,
        sourceBoxes: [caption.box],
        target: {
          regionIds: [caption.id],
          markerId: null,
        },
      })
      relationships.push({
        id: `visual-relationship-${String(relationships.length + 1).padStart(4, '0')}`,
        kind: captionLabel.kind,
        label: captionLabel.label,
        captionRegionId: caption.id,
        sourceRegionIds: [],
        sourceLineIds: [],
        sourceObjectIds: [],
        assetIds: [],
        status: 'unresolved',
        confidence: 0,
        evidence,
        candidates: [],
        sourceBoxes: [caption.box],
        sourceText: '',
        altText: caption.text,
        altTextSource: 'caption',
        canonicalNodeId: null,
        captionNodeId: null,
      })
      continue
    }
    const label: ParsedPdfScholarlyVisualLabel & { sequence: string } = {
      ...captionLabel,
      sequence: captionLabel.identifier,
    }
    let tableScopeResolution: PdfTableScopeResolution | null = null
    let semanticTableScope: CompleteSemanticTableScope | null = null
    let semanticTableGrid: PdfDetectedTableGrid | null = null
    let semanticTableLineage: PdfTableScope['regionLineage'] | null = null
    let candidates = figures.filter(
      (candidate) => candidate.kind === label.kind,
    )
    if (label.kind === 'table' || label.kind === 'equation') {
      const unavailableSourceObjectIds = new Set([
        ...reservedFigureSourceObjectIds,
        ...consumedSourceObjectIds,
      ])
      const availableTableRegions = availableRegionsForTable(
        regions,
        consumedRegionIds,
        consumedLineIds,
        reservedFigureLineIds,
        unavailableSourceObjectIds,
      )
      let detectedTable =
        label.kind === 'table'
          ? detectTableNearCaption(caption, availableTableRegions)
          : null
      if (label.kind === 'table') {
        const boundedScope = resolvePdfTableScope({
          caption,
          pageRegions: availableTableRegions,
          nativeObjects:
            pages
              .find((page) => page.page === caption.page)
              ?.objects?.filter(
                (sourceObject) =>
                  !unavailableSourceObjectIds.has(sourceObject.id),
              ) ?? [],
        })
        semanticTableLineage = boundedScope.scope?.regionLineage ?? null
        if (!detectedTable && boundedScope.scope) {
          detectedTable = detectTableWithinProvenScope(
            caption,
            availableTableRegions,
            boundedScope.scope,
          )
        }
        semanticTableScope = completeSemanticTableScope(
          detectedTable,
          boundedScope,
        )
        if (!semanticTableScope && boundedScope.scope) {
          semanticTableGrid =
            detectUniformTableWithinProvenScope(
              availableTableRegions,
              boundedScope.scope,
            ) ??
            detectWrappedHeaderTableWithinProvenScope(
              availableTableRegions,
              boundedScope.scope,
            ) ??
            detectHierarchicalTableWithinProvenScope(
              availableTableRegions,
              boundedScope.scope,
            ) ??
            detectExplicitHeaderNumericTableWithinProvenScope(
              availableTableRegions,
              boundedScope.scope,
            ) ??
            detectWrappedCellTableWithinProvenScope(
              availableTableRegions,
              boundedScope.scope,
            ) ??
            detectRectangularTableWithinProvenScope(
              availableTableRegions,
              boundedScope.scope,
            )
          const provenSemanticTable = semanticTableGrid
            ? canonicalTableFromLines(semanticTableGrid.lines, {
                sourceHeaderLineIds: [],
                detectedRectangularGeometry: true,
                detectedGrid: semanticTableGrid,
                sourceRegions: semanticTableGrid.sourceRegions,
                links:
                  pages.find((page) => page.page === caption.page)?.links ?? [],
              })
            : null
          const semanticTableAnnotationIds = (
            provenSemanticTable?.rows ?? []
          ).flatMap((row) =>
            row.cells.flatMap((cell) =>
              (cell.inlineRuns ?? []).flatMap((run) =>
                run.annotationId ? [run.annotationId] : [],
              ),
            ),
          )
          if (
            semanticTableGrid &&
            (!provenSemanticTable ||
              new Set(semanticTableAnnotationIds).size !==
                semanticTableAnnotationIds.length)
          ) {
            semanticTableGrid = null
          }
        }
        if (
          !semanticTableScope &&
          !semanticTableGrid &&
          boundedScope.scope &&
          tableCandidateProvider
        ) {
          const scope = boundedScope.scope
          const scopedLineIds = new Set(scope.sourceLineIds)
          const scopedRegions = availableTableRegions
            .filter((region) => scope.sourceRegionIds.includes(region.id))
            .map((region) => {
              if (scopedLineIds.size === 0) return region
              const lines = region.lines.filter((line) =>
                scopedLineIds.has(line.id),
              )
              return lines.length > 0
                ? {
                    ...region,
                    lines,
                    text: lines.map((line) => line.text).join(' '),
                  }
                : null
            })
            .filter((region): region is PdfPageRegion => region !== null)
          let providerDiagnostic:
            | TableCandidateReceipt['diagnostic']
            | 'table-candidate-provider-unavailable' =
            'table-candidate-provider-unavailable'
          if (rasterizeFigure && scopedRegions.length > 0) {
            const candidateImage = await rasterizeFigure({
              kind: 'table',
              page: scope.page,
              sourceBox: scope.cropBox,
              sourceObjectIds: [`table-candidate:${scope.id}`],
              sourceBoxes: [{ ...scope.cropBox }],
              tightenToSourceInk: false,
            }).catch(() => null)
            if (
              candidateImage &&
              (candidateImage.mediaType === 'image/png' ||
                candidateImage.mediaType === 'image/jpeg')
            ) {
              const candidateResult = await runTableCandidateProvider({
                provider: tableCandidateProvider,
                image: {
                  bytes: candidateImage.bytes,
                  mediaType: candidateImage.mediaType,
                  sha256: candidateImage.sha256,
                  sourceCropBox: scope.cropBox,
                },
                sourceRegions: scopedRegions,
                allowRemote: allowRemoteTableCandidateProvider,
                signal,
              })
              remoteTableCandidateUsed ||= candidateResult.remoteUsed
              let receipt = candidateResult.receipt
              if (candidateResult.verified) {
                const verifiedGrid = candidateResult.verified.grid
                const verifiedTable = canonicalTableFromLines(
                  verifiedGrid.lines,
                  {
                    detectedRectangularGeometry: true,
                    detectedGrid: verifiedGrid,
                    sourceRegions: verifiedGrid.sourceRegions,
                    links:
                      pages.find((page) => page.page === caption.page)?.links ??
                      [],
                  },
                )
                const annotationIds = (verifiedTable?.rows ?? []).flatMap(
                  (row) =>
                    row.cells.flatMap((cell) =>
                      (cell.inlineRuns ?? []).flatMap((run) =>
                        run.annotationId ? [run.annotationId] : [],
                      ),
                    ),
                )
                if (
                  verifiedTable &&
                  new Set(annotationIds).size === annotationIds.length
                ) {
                  semanticTableGrid = verifiedGrid
                } else {
                  receipt = {
                    ...receipt,
                    verifiedGridSha256: null,
                    diagnostic: 'table-candidate-proposal-failed-verification',
                  }
                }
              }
              tableCandidateReceipts.push(receipt)
              providerDiagnostic = receipt.diagnostic
            }
          }
          const diagnosticCode = {
            'table-candidate-no-proposal': 'TABLE_CANDIDATE_NO_PROPOSAL',
            'table-candidate-proposal-failed-verification':
              'TABLE_CANDIDATE_VERIFICATION_FAILED',
            'table-candidate-provider-unavailable':
              'TABLE_CANDIDATE_PROVIDER_UNAVAILABLE',
            'table-candidate-verified': 'TABLE_CANDIDATE_VERIFIED',
          }[providerDiagnostic] as ReconstructionDiagnostic['code']
          diagnostics.push({
            code: diagnosticCode,
            severity:
              providerDiagnostic === 'table-candidate-verified' ||
              providerDiagnostic === 'table-candidate-no-proposal'
                ? 'info'
                : 'warning',
            page: scope.page,
            message: `${label.label}: ${providerDiagnostic}.`,
            sourceBoxes: [scope.cropBox],
            target: {
              regionIds: [caption.id, ...scope.sourceRegionIds],
              markerId: null,
            },
          })
        }
        // A proved bounded text/native scope outranks the legacy geometric
        // detector. The latter may join a neighbouring chart that shares row
        // coordinates with a table; a scope carries exact line/object lineage.
        // Semantic promotion is allowed only when the detector consumes every
        // claimed source line and either agrees with that exact scope or closes
        // it using adjacent source-classified header regions.
        tableScopeResolution =
          semanticTableScope || semanticTableGrid
            ? null
            : boundedScope.status === 'matched' ||
                detectedTable === null ||
                (boundedScope.fallbackCandidates?.length ?? 0) > 0
              ? boundedScope
              : null
      }
      const nearbySources = nextSourceRegions(
        caption,
        availableTableRegions,
        label.kind,
      )
      const selectedSources =
        label.kind === 'table'
          ? (semanticTableGrid?.sourceRegions ??
            detectedTable?.sourceRegions ??
            [])
          : nearbySources[0]
            ? attachedEquationRegions(
                nearbySources[0],
                availableTableRegions,
                consumedRegionIds,
                new Set(),
                provedProseSplitInlineStackedFormulaBaseIds(
                  availableTableRegions,
                ),
              )
            : nearbySources
      const sources =
        label.kind === 'equation' &&
        !probableDisplayEquationText(equationSourceText(selectedSources))
          ? []
          : selectedSources
      const selectedTableSourceLineIds =
        label.kind === 'table'
          ? (semanticTableGrid?.sourceLineIds ??
            detectedTable?.sourceLineIds ??
            [])
          : []
      const exactSelectedTableSourceLines =
        selectedTableSourceLineIds.length > 0
          ? exactSourceLinesById(sources, selectedTableSourceLineIds)
          : null
      candidates = []
      if (
        !tableScopeResolution &&
        sources.length > 0 &&
        (label.kind !== 'table' ||
          selectedTableSourceLineIds.length === 0 ||
          exactSelectedTableSourceLines)
      ) {
        const sourceBox =
          label.kind === 'table' && exactSelectedTableSourceLines
            ? boxForLines(exactSelectedTableSourceLines)
            : unionBox(sources)
        const sourceObjectId = `${label.kind}-p${String(sourceBox.page).padStart(3, '0')}-${String(captionIndex + 1).padStart(3, '0')}`
        const page = pages.find((item) => item.page === sourceBox.page)!
        const sourceLines = sources.flatMap((source) => source.lines)
        const incompleteDetectedTable =
          label.kind === 'table' &&
          semanticTableScope === null &&
          semanticTableGrid === null &&
          detectedTable !== null &&
          tableRowBandCount(sourceLines) >
            tableRowBandCount(detectedTable.lines)
        const lines = incompleteDetectedTable
          ? sourceLines
          : (semanticTableGrid?.lines ?? detectedTable?.lines ?? sourceLines)
        const nativeEquationRendition =
          label.kind === 'equation'
            ? sourceEquationRendition(
                caption,
                sources,
                availableTableRegions,
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
                  detectedRectangularGeometry: Boolean(
                    semanticTableScope || semanticTableGrid,
                  ),
                  detectedGrid: semanticTableGrid ?? undefined,
                  sourceRegions: sources,
                  links: page.links ?? [],
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
            detectedRectangularGeometry: Boolean(
              semanticTableScope || semanticTableGrid,
            ),
            detectedGrid: semanticTableGrid ?? undefined,
            sourceRegions: sources,
            links: page.links ?? [],
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
              label.kind === 'table' && (semanticTableGrid || detectedTable)
                ? [
                    ...(semanticTableGrid?.sourceLineIds ??
                      detectedTable!.sourceLineIds),
                  ]
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
            ...(label.kind === 'table' &&
            semanticTableGrid &&
            semanticTableLineage
              ? {
                  // Preserve the independently proved line ownership even
                  // when caption scoring leaves the relationship unresolved.
                  // This keeps a source-backed table out of flowing prose
                  // without pretending the caption association is certain.
                  tableRegionLineage: semanticTableLineage.map((lineage) => ({
                    ...lineage,
                    lineIds: [...lineage.lineIds],
                    retainedLineIds: [...lineage.retainedLineIds],
                    box: { ...lineage.box },
                  })),
                }
              : {}),
            ...(label.kind === 'table'
              ? {
                  evidence: visualAsset
                    ? [
                        ...(semanticTableLineage
                          ? ['bounded-table-scope']
                          : []),
                        'detected-table-geometry',
                        'semantic-table',
                        ...(semanticTableScope?.evidence ?? []),
                        ...(semanticTableGrid?.evidence ?? []),
                      ]
                    : [
                        'detected-table-geometry',
                        'semantic-table-unresolved',
                        'exact-source-raster-unavailable',
                        ...(semanticTableScope?.evidence ?? []),
                        ...(semanticTableGrid?.evidence ?? []),
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
    let result = tableScopeResolution
      ? matchTableScopeResolution(
          tableScopeResolution,
          caption,
          regions,
          objectAssetIds,
        )
      : matchCandidate(caption, label, candidates, regions)
    const bestHasCompleteSingleAsset = Boolean(
      result.best?.candidate.sourceObjectIds.length === 1 &&
      result.best.candidate.assetIds.length === 1 &&
      assetStore.has(result.best.candidate.assetIds[0]),
    )
    if (label.kind === 'figure' && !bestHasCompleteSingleAsset) {
      const fallbackCandidate = sourcePreservedFigureFallbackCandidate({
        caption,
        pages,
        regions,
        assetStore,
        renderEnvelope: result.best?.candidate.renderBox,
      })
      if (fallbackCandidate) {
        candidates = [...candidates, fallbackCandidate]
        const fallbackResult = matchCandidate(
          caption,
          label,
          [fallbackCandidate],
          regions,
        )
        if (fallbackResult.matched) {
          // A complete source image is a safer rendition than an incomplete
          // grouped scaffold, but the scaffold must remain in the evidence
          // set so ownership conflicts and unreferenced obligations are not
          // erased. Promote the exact fallback without turning the two
          // representations into an artificial ambiguity.
          result = {
            ...fallbackResult,
            scored: [...result.scored, ...fallbackResult.scored],
            ambiguous: false,
            matched: true,
          }
        } else {
          // Keep the original grouped candidates in the ambiguity set. A
          // rejected fallback is evidence of attempted recovery, not a
          // reason to discard competing native lineage.
          result = {
            ...result,
            scored: [...result.scored, ...fallbackResult.scored],
          }
        }
      }
    }
    const scoredCandidateRecords = result.scored.map((scored) =>
      matchRecord(scored, regions),
    )
    const matchedCandidate = result.best?.candidate
    const sourcePreservedTableFallback = Boolean(
      label.kind === 'table' &&
      matchedCandidate?.evidence?.includes('source-preserved-table-fallback'),
    )
    const sourcePageCropVetoed = Boolean(
      matchedCandidate?.sourcePageCropBlockedByReadingOrderText,
    )
    const nativeCandidate = matchedCandidate
      ? nativeOnlyFigureCandidate(matchedCandidate, regions, objectAssetIds)
      : undefined
    // Crop recovery narrows source lineage for one caption. Keep that
    // working copy isolated from the shared candidate pool so a later
    // caption can still evaluate the original full-width composite scope.
    const best = nativeCandidate
      ? {
          ...nativeCandidate,
          sourceRegionIds: [...nativeCandidate.sourceRegionIds],
          sourceLineIds: nativeCandidate.sourceLineIds
            ? [...nativeCandidate.sourceLineIds]
            : undefined,
          sourceObjectIds: [...nativeCandidate.sourceObjectIds],
          assetIds: [...nativeCandidate.assetIds],
          sourceBoxes: nativeCandidate.sourceBoxes.map((sourceBox) => ({
            ...sourceBox,
          })),
          renderBox: nativeCandidate.renderBox
            ? { ...nativeCandidate.renderBox }
            : undefined,
          textOwnershipBox: nativeCandidate.textOwnershipBox
            ? { ...nativeCandidate.textOwnershipBox }
            : undefined,
          evidence: nativeCandidate.evidence
            ? [...nativeCandidate.evidence]
            : undefined,
        }
      : undefined
    const laneScopedRenderBox =
      best && best.kind === 'figure'
        ? captionLaneScopedRenderBox(caption, best)
        : best?.renderBox
    const laneHorizontalBounds =
      best?.kind === 'figure' && laneScopedRenderBox
        ? captionLaneHorizontalBounds(caption)
        : undefined
    const figureOwnershipScope =
      best?.kind === 'figure'
        ? laneScopedRenderBox
          ? paddedUnionBox([laneScopedRenderBox], laneHorizontalBounds)
          : (best.renderBox ?? best.sourceBoxes[0])
        : null
    const figureOwnershipSourceObjectIds =
      best?.kind === 'figure' ? [...best.sourceObjectIds] : []
    const figureLineageConflictsPriorOwnership =
      best?.kind === 'figure' &&
      (best.sourceObjectIds.some((sourceObjectId) => {
        if (!consumedSourceObjectIds.has(sourceObjectId)) return false
        const priorScopes = consumedSourceObjectScopes.get(sourceObjectId)
        if (!figureOwnershipScope || !priorScopes || priorScopes.length === 0) {
          return true
        }
        return priorScopes.some((priorScope) =>
          materiallyOverlappingSourceBoxes(priorScope, figureOwnershipScope),
        )
      }) ||
        containedFigureOverlayLineage(best, regions, {
          ...(figureOwnershipScope
            ? { containmentBox: figureOwnershipScope }
            : {}),
        }).some((overlay) =>
          overlay.lineIds.some((lineId) => consumedLineIds.has(lineId)),
        ))
    if (
      figureLineageConflictsPriorOwnership &&
      result.best &&
      !result.best.evidence.includes('cross-type-source-lineage-conflict')
    ) {
      result.best.evidence.push('cross-type-source-lineage-conflict')
    }
    const boundedCropBaseBox =
      laneScopedRenderBox ??
      (best?.kind === 'table' && best.sourceBoxes.length === 1
        ? { ...best.sourceBoxes[0] }
        : null)
    const selectedTableLineIds =
      best?.kind === 'table'
        ? new Set(
            best.sourceLineIds ??
              best.sourceRegionIds.flatMap(
                (sourceRegionId) =>
                  regions
                    .find((region) => region.id === sourceRegionId)
                    ?.lines.map((line) => line.id) ?? [],
              ),
          )
        : null
    const initialTableCropBox = best
      ? paddedUnionBox(
          laneScopedRenderBox ? [laneScopedRenderBox] : best.sourceBoxes,
          laneHorizontalBounds,
        )
      : null
    const captionBoundedTextSlabEnvelope = Boolean(
      best?.kind === 'table' &&
      best.sourceObjectIds.length === 1 &&
      best.sourceObjectIds[0].startsWith(
        'table-scope-source:pdf-table-scope:caption-bounded-text-slab:',
      ) &&
      best.evidence?.includes('caption-bounded-scope'),
    )
    const exhaustiveTextSlabTableEnvelope = Boolean(
      captionBoundedTextSlabEnvelope &&
      best?.kind === 'table' &&
      best.evidence?.includes('contiguous-tabular-slab'),
    )
    const proactiveTextSlabVerticalEnvelope =
      best?.kind === 'table' &&
      boundedCropBaseBox &&
      selectedTableLineIds &&
      initialTableCropBox &&
      captionBoundedTextSlabEnvelope
        ? (neighborBoundedCropBoxes(
            boundedCropBaseBox,
            selectedTableLineIds,
            regions,
            TABLE_SOURCE_CROP_RETRY_PADDINGS[
              TABLE_SOURCE_CROP_RETRY_PADDINGS.length - 1
            ],
            TABLE_SOURCE_CROP_NEIGHBOR_GAP_FRACTIONS[
              TABLE_SOURCE_CROP_NEIGHBOR_GAP_FRACTIONS.length - 1
            ],
          ).map((verticalEnvelope) => ({
            ...initialTableCropBox,
            y: verticalEnvelope.y,
            height: verticalEnvelope.height,
          }))[0] ?? null)
        : null
    const sourceObjectBoxes = (best?.sourceObjectIds ?? [])
      .map((id) => lineageBoxes.get(id))
      .filter((box): box is NormalizedSourceBox => Boolean(box))
    let compositeSourceBox: NormalizedSourceBox | null = best
      ? (proactiveTextSlabVerticalEnvelope ?? initialTableCropBox)
      : null
    let tableNeighborBoundedCrop = Boolean(proactiveTextSlabVerticalEnvelope)
    let adaptiveTableNeighborGap = false
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
    const sourceCandidateEligibleForCrop =
      result.matched || sourcePreservedTableFallback
    if (
      sourceCandidateEligibleForCrop &&
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
      sourceCandidateEligibleForCrop &&
      best &&
      scopedSourceLineage &&
      scopedSourceLineage.sourceObjectIds.length > 0 &&
      scopedSourceLineage.sourceObjectIds.length ===
        scopedSourceLineage.sourceBoxes.length &&
      compositeSourceBox &&
      rasterizeFigure &&
      !figureLineageConflictsPriorOwnership &&
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
        boundedCropBaseBox &&
        !captionBoundedTextSlabEnvelope &&
        !sameSourceBox(compositeSourceBox, boundedCropBaseBox)
      ) {
        const boundedSourceBox = { ...boundedCropBaseBox }
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
            cropTouchedEdge = sourcePageCropTouchesEdge(error)
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
        !sourceCrop &&
        cropTouchedEdge &&
        best.kind === 'figure' &&
        boundedCropBaseBox
      ) {
        const retryBox = captionTextBoundedFigureRetryBox(
          best,
          boundedCropBaseBox,
          caption.box,
          laneHorizontalBounds,
        )
        const retryLineage =
          retryBox &&
          renderScopeContainsCompleteFigureLineage(best, retryBox, regions)
            ? {
                sourceObjectIds: [...best.sourceObjectIds],
                sourceBoxes: best.sourceBoxes.map((sourceBox) => ({
                  ...sourceBox,
                })),
                clipped: false,
              }
            : null
        if (
          retryBox &&
          retryLineage &&
          retryLineage.sourceObjectIds.length > 0 &&
          retryLineage.sourceObjectIds.length ===
            retryLineage.sourceBoxes.length
        ) {
          const retryCrop = await rasterizeFigure({
            kind: best.kind,
            page: best.page,
            sourceBox: retryBox,
            sourceObjectIds: [...retryLineage.sourceObjectIds],
            sourceBoxes: retryLineage.sourceBoxes.map((box) => ({ ...box })),
          }).catch((error: unknown) => {
            cropTouchedEdge = sourcePageCropTouchesEdge(error)
            pageCropFailureEvidence = sourcePageCropFailureEvidence(error)
            return null
          })
          if (
            retryCrop &&
            completeSourcePageCropAsset(
              retryCrop,
              best.kind,
              retryLineage.sourceObjectIds,
              retryLineage.sourceBoxes,
              retryBox,
            )
          ) {
            sourceCrop = retryCrop
            compositeSourceBox = retryBox
            scopedSourceLineage = retryLineage
            pageCropFailureEvidence = undefined
            result.best!.evidence.push(
              'source-page-crop-caption-text-bounded-edge-retry',
            )
          }
        }
      }
      if (
        !sourceCrop &&
        cropTouchedEdge &&
        best.kind === 'figure' &&
        boundedCropBaseBox &&
        result.best &&
        !result.best.evidence.includes(
          'source-reused-page-edge-clipping-layer',
        ) &&
        result.best.evidence.some((item) =>
          [
            'connected-native-scaffold',
            'caption-bounded-native-scaffold',
            'caption-bounded-semantic-envelope',
          ].includes(item),
        )
      ) {
        const claimedRegionIds = new Set(best.sourceRegionIds)
        const selectedLineIds = new Set(
          regions
            .filter((region) => claimedRegionIds.has(region.id))
            .flatMap((region) => region.lines.map((line) => line.id)),
        )
        const attemptedBoxes = [compositeSourceBox, boundedCropBaseBox]
        retryFigureEnvelopeCrop: for (const padding of CAPTION_ENVELOPE_SOURCE_CROP_RETRY_PADDINGS) {
          const retryBoxes = neighborBoundedCropBoxes(
            boundedCropBaseBox,
            selectedLineIds,
            regions,
            padding,
            0.75,
            laneHorizontalBounds,
          )
          for (const retryBox of retryBoxes) {
            if (
              attemptedBoxes.some((attempted) =>
                sameSourceBox(attempted, retryBox),
              )
            ) {
              continue
            }
            attemptedBoxes.push(retryBox)
            const overlapsUnclaimedFlowText = regions.some(
              (region) =>
                region.page === retryBox.page &&
                !claimedRegionIds.has(region.id) &&
                region.includedInReadingOrder &&
                region.nativeObjectIds.length === 0 &&
                region.lines.length > 0 &&
                region.text.trim().length > 0 &&
                ['body', 'spanning'].includes(region.kind) &&
                materiallyOverlappingSourceBoxes(retryBox, region.box),
            )
            if (
              overlapsUnclaimedFlowText ||
              !renderScopeContainsCompleteFigureLineage(best, retryBox, regions)
            ) {
              continue
            }
            const retryLineage = sourceLineageWithinRenderScope(best, retryBox)
            if (
              retryLineage.sourceObjectIds.length === 0 ||
              retryLineage.sourceObjectIds.length !==
                retryLineage.sourceBoxes.length
            ) {
              continue
            }
            let retryTouchedEdge = false
            const retryCrop = await rasterizeFigure({
              kind: best.kind,
              page: best.page,
              sourceBox: retryBox,
              sourceObjectIds: [...retryLineage.sourceObjectIds],
              sourceBoxes: retryLineage.sourceBoxes.map((box) => ({
                ...box,
              })),
            }).catch((error: unknown) => {
              retryTouchedEdge = sourcePageCropTouchesEdge(error)
              pageCropFailureEvidence = sourcePageCropFailureEvidence(error)
              return null
            })
            if (
              retryCrop &&
              completeSourcePageCropAsset(
                retryCrop,
                best.kind,
                retryLineage.sourceObjectIds,
                retryLineage.sourceBoxes,
                retryBox,
              )
            ) {
              sourceCrop = retryCrop
              compositeSourceBox = retryBox
              scopedSourceLineage = retryLineage
              pageCropFailureEvidence = undefined
              result.best.evidence.push(
                'source-page-crop-adaptive-caption-envelope',
              )
              break retryFigureEnvelopeCrop
            }
            if (!retryTouchedEdge) break retryFigureEnvelopeCrop
          }
        }
      }
      if (
        !sourceCrop &&
        cropTouchedEdge &&
        best.kind === 'table' &&
        boundedCropBaseBox &&
        selectedTableLineIds
      ) {
        const attemptedBoxes = [compositeSourceBox, boundedCropBaseBox]
        let retainedTableNeighborGapFraction: number | null = null
        retryTableCrop: for (const neighborGapFraction of TABLE_SOURCE_CROP_NEIGHBOR_GAP_FRACTIONS) {
          retryTablePadding: for (const padding of tableSourceCropRetryPaddings(
            boundedCropBaseBox,
          )) {
            const retryBoxes = neighborBoundedCropBoxes(
              boundedCropBaseBox,
              selectedTableLineIds,
              regions,
              padding,
              neighborGapFraction,
            )
            for (const retryBox of retryBoxes) {
              if (
                attemptedBoxes.some((attempted) =>
                  sameSourceBox(attempted, retryBox),
                )
              ) {
                continue
              }
              attemptedBoxes.push(retryBox)
              const retryLineage = sourceLineageWithinRenderScope(
                best,
                retryBox,
              )
              if (
                retryLineage.sourceObjectIds.length === 0 ||
                retryLineage.sourceObjectIds.length !==
                  retryLineage.sourceBoxes.length
              ) {
                continue
              }
              let retryTouchedEdge = false
              const retryCrop = await rasterizeFigure({
                kind: best.kind,
                page: best.page,
                sourceBox: retryBox,
                sourceObjectIds: [...retryLineage.sourceObjectIds],
                sourceBoxes: retryLineage.sourceBoxes.map((box) => ({
                  ...box,
                })),
              }).catch((error: unknown) => {
                retryTouchedEdge = sourcePageCropTouchesEdge(error)
                pageCropFailureEvidence = sourcePageCropFailureEvidence(error)
                return null
              })
              if (
                retryCrop &&
                completeSourcePageCropAsset(
                  retryCrop,
                  best.kind,
                  retryLineage.sourceObjectIds,
                  retryLineage.sourceBoxes,
                  retryBox,
                )
              ) {
                sourceCrop = retryCrop
                compositeSourceBox = retryBox
                scopedSourceLineage = retryLineage
                pageCropFailureEvidence = undefined
                retainedTableNeighborGapFraction = neighborGapFraction
                if (exhaustiveTextSlabTableEnvelope) {
                  break retryTablePadding
                }
                break retryTableCrop
              }
              if (!retryTouchedEdge) break retryTableCrop
            }
          }
        }
        if (retainedTableNeighborGapFraction !== null) {
          adaptiveTableNeighborGap =
            retainedTableNeighborGapFraction >
            TABLE_SOURCE_CROP_NEIGHBOR_GAP_FRACTIONS[0]
          tableNeighborBoundedCrop = true
        }
      }
      const tightenedSourceCropFailure =
        sourceCrop?.sourceCropBox &&
        !sameSourceBox(sourceCrop.sourceCropBox, compositeSourceBox!)
          ? sourcePageCropValidationFailure(
              sourceCrop,
              best.kind,
              scopedSourceLineage.sourceObjectIds,
              scopedSourceLineage.sourceBoxes,
              compositeSourceBox!,
            )
          : null
      if (
        sourceCrop &&
        best.kind === 'figure' &&
        !result.best?.evidence.includes('caption-bounded-native-scaffold') &&
        [
          'source-page-crop-lineage-rejected',
          'source-page-crop-lineage-geometry-rejected',
          'source-page-crop-containment-rejected',
        ].includes(tightenedSourceCropFailure ?? '') &&
        renderScopeContainsCompleteFigureLineage(
          best,
          compositeSourceBox!,
          regions,
        )
      ) {
        const completeSourceObjectIds = [...best.sourceObjectIds]
        const completeSourceBoxes = best.sourceBoxes.map((sourceBox) => ({
          ...sourceBox,
        }))
        const untrimmedCrop = await rasterizeFigure({
          kind: best.kind,
          page: best.page,
          sourceBox: compositeSourceBox!,
          sourceObjectIds: completeSourceObjectIds,
          sourceBoxes: completeSourceBoxes,
          tightenToSourceInk: false,
        }).catch((error: unknown) => {
          pageCropFailureEvidence = sourcePageCropFailureEvidence(error)
          return null
        })
        sourceCrop = untrimmedCrop
        if (
          untrimmedCrop &&
          completeSourcePageCropAsset(
            untrimmedCrop,
            best.kind,
            completeSourceObjectIds,
            completeSourceBoxes,
            compositeSourceBox!,
          )
        ) {
          scopedSourceLineage = {
            sourceObjectIds: completeSourceObjectIds,
            sourceBoxes: completeSourceBoxes,
            clipped: false,
          }
          pageCropFailureEvidence = undefined
          result.best!.evidence.push(
            'source-page-crop-complete-lineage-preserved',
          )
        } else if (untrimmedCrop) {
          pageCropFailureEvidence =
            sourcePageCropValidationFailure(
              untrimmedCrop,
              best.kind,
              completeSourceObjectIds,
              completeSourceBoxes,
              compositeSourceBox!,
            ) ?? undefined
        }
      }
      if (
        sourceCrop &&
        sourceBoxWithinHorizontalBounds(
          sourceCrop.sourceCropBox ?? compositeSourceBox!,
          laneHorizontalBounds,
        ) &&
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
        if (best.kind === 'figure') {
          Object.assign(
            best,
            projectFigureLineageToAcceptedSourceCrop(
              best,
              sourceCrop,
              compositeSourceBox,
              caption,
              regions,
            ),
          )
        } else {
          best.sourceObjectIds = [...scopedSourceLineage.sourceObjectIds]
          best.sourceBoxes = scopedSourceLineage.sourceBoxes.map((box) => ({
            ...box,
          }))
          best.sourceRegionIds = best.sourceRegionIds.filter(
            (sourceRegionId) => {
              const sourceRegion = regions.find(
                (region) => region.id === sourceRegionId,
              )
              return Boolean(
                sourceRegion &&
                intersectSourceBox(compositeSourceBox!, sourceRegion.box),
              )
            },
          )
        }
        best.assetIds = [sourceCrop.id]
        retainedPageCrop = sourceCrop
        result.best!.evidence = result.best!.evidence.filter(
          (item) => item !== 'exact-source-raster-unavailable',
        )
        result.best!.evidence.push('source-page-crop')
        if (best.kind === 'table' && tableNeighborBoundedCrop) {
          result.best!.evidence.push('source-page-crop-neighbor-bounded')
        }
        if (best.kind === 'table' && adaptiveTableNeighborGap) {
          result.best!.evidence.push('source-page-crop-adaptive-neighbor-gap')
        }
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
      result.matched &&
      best?.kind === 'figure' &&
      rasterizeFigure &&
      !figureLineageConflictsPriorOwnership &&
      !retainedPageCrop &&
      !sourcePageCropVetoed
    ) {
      const panelRecoveryBoxes = captionBoundedPanelRecoveryBoxes(
        best,
        caption,
        regions,
        objectKinds,
        pageCropFailureEvidence,
        laneHorizontalBounds,
      )
      const sourceObjectId = `source-panel:${caption.id}`
      for (const recovery of panelRecoveryBoxes) {
        let retryTouchedEdge = false
        const retryCrop = await rasterizeFigure({
          kind: 'figure',
          page: best.page,
          sourceBox: recovery.sourceBox,
          sourceObjectIds: [sourceObjectId],
          sourceBoxes: [recovery.sourceBox],
          ownedSourceBoxes: recovery.ownedSourceBoxes,
        }).catch((error: unknown) => {
          retryTouchedEdge = sourcePageCropTouchesEdge(error)
          pageCropFailureEvidence = sourcePageCropFailureEvidence(error)
          return null
        })
        if (
          retryCrop &&
          sourceBoxWithinHorizontalBounds(
            retryCrop.sourceCropBox ?? recovery.sourceBox,
            laneHorizontalBounds,
          ) &&
          completeSourcePageCropAsset(
            retryCrop,
            'figure',
            [sourceObjectId],
            [recovery.sourceBox],
            recovery.sourceBox,
          )
        ) {
          mergeAsset(assetStore, retryCrop)
          compositeSourceBox = {
            ...(retryCrop.sourceCropBox ?? recovery.sourceBox),
          }
          scopedSourceLineage = {
            sourceObjectIds: [...retryCrop.sourceObjectIds],
            sourceBoxes: retryCrop.sourceBoxes.map((box) => ({ ...box })),
            clipped: !sameSourceBox(compositeSourceBox, recovery.sourceBox),
          }
          Object.assign(
            best,
            projectFigureLineageToAcceptedSourceCrop(
              best,
              retryCrop,
              compositeSourceBox,
              caption,
              regions,
            ),
          )
          best.assetIds = [retryCrop.id]
          best.nativeEnvelopeIncomplete = false
          retainedPageCrop = retryCrop
          pageCropFailureEvidence = undefined
          result.best!.evidence = result.best!.evidence.filter(
            (item) => item !== 'exact-source-raster-unavailable',
          )
          result.best!.evidence.push(
            'source-page-crop-caption-bounded-panel-recovery',
            'source-panel-synthetic-crop-lineage',
            ...recovery.evidence,
            'source-page-crop',
          )
          break
        }
        if (retryCrop) {
          pageCropFailureEvidence =
            sourcePageCropValidationFailure(
              retryCrop,
              'figure',
              [sourceObjectId],
              [recovery.sourceBox],
              recovery.sourceBox,
            ) ?? undefined
        }
        if (!retryTouchedEdge) break
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
      !figureLineageConflictsPriorOwnership &&
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
      !figureLineageConflictsPriorOwnership &&
      !best!.nativeEnvelopeIncomplete &&
      best!.sourceObjectIds.length > 0 &&
      (Boolean(
        retainedPageCrop &&
        compositeSourceBox &&
        sourceBoxWithinHorizontalBounds(
          compositeSourceBox,
          laneHorizontalBounds,
        ) &&
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
    const ownsUnresolvedProvenSemanticTableText = Boolean(
      status === 'unresolved' &&
      label.kind === 'table' &&
      result.best?.candidate.evidence?.includes('semantic-table') &&
      result.best?.candidate.tableRegionLineage?.length,
    )
    const ownsUnresolvedBoundedTableText =
      status === 'unresolved' &&
      label.kind === 'table' &&
      (result.matched ||
        sourcePreservedTableFallback ||
        ownsUnresolvedProvenSemanticTableText) &&
      Boolean(matchedCandidate?.tableRegionLineage?.length) &&
      matchedCandidate!.tableRegionLineage!.every(
        (lineage) => lineage.lineIds.length > 0,
      )
    const unresolvedBoundedTableLineageIsWholeRegion =
      ownsUnresolvedBoundedTableText &&
      matchedCandidate!.tableRegionLineage!.every(
        (lineage) => lineage.selection === 'whole',
      )
    const unresolvedBoundedTableRegionIds = ownsUnresolvedBoundedTableText
      ? [
          ...new Set(
            matchedCandidate!.tableRegionLineage!.map(
              (lineage) => lineage.regionId,
            ),
          ),
        ]
      : []
    const unresolvedBoundedTableSelectedLineIds = ownsUnresolvedBoundedTableText
      ? new Set(
          matchedCandidate!.tableRegionLineage!.flatMap(
            (lineage) => lineage.lineIds,
          ),
        )
      : new Set<string>()
    const unresolvedBoundedTableLineIds = ownsUnresolvedBoundedTableText
      ? regions
          .filter((region) =>
            unresolvedBoundedTableRegionIds.includes(region.id),
          )
          .flatMap((region) => region.lines)
          .filter((line) => unresolvedBoundedTableSelectedLineIds.has(line.id))
          .sort(
            (left, right) =>
              left.box.page - right.box.page ||
              left.box.y - right.box.y ||
              left.box.x - right.box.x ||
              left.id.localeCompare(right.id),
          )
          .map((line) => line.id)
      : []
    const unresolvedFigureOverlays =
      status === 'unresolved' &&
      label.kind === 'figure' &&
      result.matched &&
      matchedCandidate?.renderBox &&
      uniqueStrongFigureOwnerByCandidate.get(matchedCandidate) === caption.id &&
      result.best?.evidence.includes('caption-bounded-native-scaffold')
        ? containedFigureOverlayLineage(matchedCandidate, regions, {
            excludedLineIds: consumedLineIds,
          })
        : []
    const unresolvedOverlayRegionIds = unresolvedFigureOverlays.map(
      (overlay) => overlay.regionId,
    )
    const unresolvedFigureLineIds = unresolvedFigureOverlays.flatMap(
      (overlay) => overlay.lineIds,
    )
    const ownsUnresolvedFigureText = unresolvedFigureOverlays.length > 0
    if (
      ownsUnresolvedFigureText &&
      result.best &&
      !result.best.evidence.includes('unresolved-visual-text-owned')
    ) {
      result.best.evidence.push('unresolved-visual-text-owned')
    }
    if (
      ownsUnresolvedBoundedTableText &&
      result.best &&
      !result.best.evidence.includes('unresolved-bounded-table-text-owned')
    ) {
      result.best.evidence.push('unresolved-bounded-table-text-owned')
    }
    if (status === 'matched') {
      const finalFigureOwnershipScope =
        best!.kind === 'figure' && retainedPageCrop && compositeSourceBox
          ? compositeSourceBox
          : figureOwnershipScope
      const consumedRelationshipSourceObjectIds =
        best!.kind === 'figure'
          ? [
              ...new Set([
                ...figureOwnershipSourceObjectIds,
                ...best!.sourceObjectIds,
              ]),
            ]
          : best!.sourceObjectIds
      for (const sourceObjectId of consumedRelationshipSourceObjectIds) {
        consumedSourceObjectIds.add(sourceObjectId)
        if (finalFigureOwnershipScope && best!.kind === 'figure') {
          const priorScopes =
            consumedSourceObjectScopes.get(sourceObjectId) ?? []
          priorScopes.push({ ...finalFigureOwnershipScope })
          consumedSourceObjectScopes.set(sourceObjectId, priorScopes)
        }
      }
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
        } else if (
          label.kind === 'equation' &&
          best!.sourceLineIds &&
          best!.sourceLineIds.length > 0
        ) {
          const selectedLineIds = new Set(best!.sourceLineIds)
          for (const sourceRegionId of best!.sourceRegionIds) {
            const regionLineIds =
              regions
                .find((region) => region.id === sourceRegionId)
                ?.lines.map((line) => line.id)
                .filter((lineId) => selectedLineIds.has(lineId)) ?? []
            consumeRegionLineSelection(
              sourceRegionId,
              regionLineIds,
              regions,
              consumedRegionIds,
              consumedLineIds,
            )
          }
        } else {
          for (const sourceRegionId of best!.sourceRegionIds) {
            consumedRegionIds.add(sourceRegionId)
          }
        }
      } else {
        const captionBoundedPanelRecovery = result.best?.evidence.includes(
          'source-page-crop-caption-bounded-panel-recovery',
        )
        const retainedSourceRegionIds = new Set(best!.sourceRegionIds)
        const selectedFigureLineIds = new Set(best!.sourceLineIds ?? [])
        const consumeMatchedFigureTextRegion = (sourceRegionId: string) => {
          if (selectedFigureLineIds.size === 0) {
            consumedRegionIds.add(sourceRegionId)
            return
          }
          const regionLineIds =
            regions
              .find((region) => region.id === sourceRegionId)
              ?.lines.map((line) => line.id)
              .filter((lineId) => selectedFigureLineIds.has(lineId)) ?? []
          if (regionLineIds.length === 0) return
          consumeRegionLineSelection(
            sourceRegionId,
            regionLineIds,
            regions,
            consumedRegionIds,
            consumedLineIds,
          )
        }
        if (captionBoundedPanelRecovery) {
          for (const sourceRegionId of retainedSourceRegionIds) {
            const sourceRegion = regions.find(
              (region) => region.id === sourceRegionId,
            )
            if (
              sourceRegion &&
              sourceRegion.nativeObjectIds.length === 0 &&
              sourceRegion.lines.length > 0 &&
              sourceRegion.text.trim().length > 0
            ) {
              consumeMatchedFigureTextRegion(sourceRegionId)
            }
          }
        }
        for (const sourceObjectId of best!.sourceObjectIds) {
          if (!sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX)) continue
          const sourceRegionId = sourceObjectId.slice(
            TEXT_OVERLAY_PREFIX.length,
          )
          if (retainedSourceRegionIds.has(sourceRegionId)) {
            consumeMatchedFigureTextRegion(sourceRegionId)
          }
        }
      }
    } else if (
      unresolvedBoundedTableLineageIsWholeRegion &&
      !sourcePreservedTableFallback
    ) {
      // Whole-region source scopes remain owned by the unresolved table.
      // Partial-parent scopes stay in canonical flow because consuming only
      // their selected lines would drop the sole recoverable table text.
      for (const lineage of matchedCandidate!.tableRegionLineage!) {
        consumeRegionLineSelection(
          lineage.regionId,
          lineage.lineIds,
          regions,
          consumedRegionIds,
          consumedLineIds,
        )
      }
    } else if (ownsUnresolvedFigureText) {
      // The visual rendition is still unresolved, but its diagram-internal
      // text is unambiguously enclosed by the single caption-bounded figure
      // candidate. Keep that text with the unresolved visual transcript; do
      // not splice it into the surrounding scholarly prose.
      for (const overlay of unresolvedFigureOverlays) {
        consumeRegionLineSelection(
          overlay.regionId,
          overlay.lineIds,
          regions,
          consumedRegionIds,
          consumedLineIds,
        )
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
      sourceRegionIds:
        status === 'matched'
          ? best!.sourceRegionIds
          : ownsUnresolvedBoundedTableText
            ? unresolvedBoundedTableRegionIds
            : unresolvedOverlayRegionIds,
      sourceLineIds:
        status === 'matched'
          ? [...(best!.sourceLineIds ?? [])]
          : ownsUnresolvedBoundedTableText
            ? unresolvedBoundedTableLineIds
            : unresolvedFigureLineIds,
      sourceObjectIds:
        status === 'matched' ||
        (sourcePreservedTableFallback && payloadComplete)
          ? best!.sourceObjectIds
          : [],
      assetIds:
        status === 'matched' ||
        (sourcePreservedTableFallback && payloadComplete)
          ? best!.assetIds
          : [],
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
          : ownsUnresolvedBoundedTableText
            ? [caption.box, ...matchedCandidate!.sourceBoxes]
            : ownsUnresolvedFigureText
              ? [
                  caption.box,
                  ...unresolvedFigureOverlays.map(
                    (overlay) => overlay.sourceBox,
                  ),
                ]
              : [caption.box],
      sourceText:
        status === 'matched'
          ? best!.sourceText
          : ownsUnresolvedBoundedTableText
            ? matchedCandidate!.sourceText
            : ownsUnresolvedFigureText
              ? unresolvedFigureOverlays
                  .map((overlay) => overlay.sourceText)
                  .join(' ')
              : '',
      altText: caption.text,
      altTextSource: 'caption',
      canonicalNodeId: null,
      captionNodeId: null,
    })
  }
  onProgress?.({
    phase: 'semantic-promotion',
    completed: captions.length,
    total: captions.length,
    message: `Resolved ${captions.length} typed visual captions…`,
  })
  await yieldPdfVisualTask(signal)

  const preformattedCountByPage = new Map<number, number>()
  for (const [blockIndex, block] of preformattedBlocks.entries()) {
    if (
      blockIndex > 0 &&
      blockIndex % PDF_VISUAL_COOPERATIVE_BATCH_SIZE === 0
    ) {
      onProgress?.({
        phase: 'semantic-promotion',
        completed: blockIndex,
        total: preformattedBlocks.length,
        message: `Resolving bounded preformatted blocks ${blockIndex} of ${preformattedBlocks.length}…`,
      })
      await yieldPdfVisualTask(signal)
    }
    const pageSequence =
      (preformattedCountByPage.get(block.caption.page) ?? 0) + 1
    preformattedCountByPage.set(block.caption.page, pageSequence)
    const retainedCaption =
      block.captionFallbackLineId !== null
        ? (block.caption.lines.find(
            (line) => line.id === block.captionFallbackLineId,
          )?.text ?? block.label)
        : retainedCaptionText(
            block.caption,
            new Set(block.sourceLines.map(({ line }) => line.id)),
          ) || block.caption.text
    const renderedSegments: Array<{
      asset: PdfVisualAsset
      sourceObjectIds: string[]
      sourceObjectBoxes: NormalizedSourceBox[]
      sourceCropBox: NormalizedSourceBox
      adaptivePaddingRetry: boolean
    }> = []
    let allSegmentsMatched =
      Boolean(rasterizeFigure) && block.segments.length > 0
    for (const [segmentIndex, segment] of block.segments.entries()) {
      const syntheticSourceObjectId = `code-source-p${String(
        segment.page,
      ).padStart(3, '0')}-${String(pageSequence).padStart(3, '0')}-${String(
        segmentIndex + 1,
      ).padStart(3, '0')}`
      const sourceObjectIds =
        segment.sourceObjectIds.length > 0
          ? segment.sourceObjectIds
          : [syntheticSourceObjectId]
      const sourceObjectBoxes =
        segment.sourceObjectBoxes.length > 0
          ? segment.sourceObjectBoxes
          : [segment.sourceBox]
      const selectedLineIds = new Set(
        segment.sourceLines.map(({ line }) => line.id),
      )
      let sourceCropBox = neighborBoundedCropBoxes(
        segment.sourceBox,
        selectedLineIds,
        regions,
        PREFORMATTED_SOURCE_CROP_PADDING,
      )[0]
      let sourceCrop: PdfVisualAsset | null = null
      let cropTouchedEdge = false
      let adaptivePaddingRetry = false
      if (rasterizeFigure) {
        sourceCrop = await rasterizeFigure({
          kind: 'figure',
          page: segment.page,
          sourceBox: sourceCropBox,
          sourceObjectIds,
          sourceBoxes: sourceObjectBoxes,
          tightenToSourceInk: false,
        }).catch((error: unknown) => {
          cropTouchedEdge = sourcePageCropTouchesEdge(error)
          return null
        })
        const attemptedBoxes = [sourceCropBox]
        retryPreformattedCrop: for (const padding of PREFORMATTED_SOURCE_CROP_RETRY_PADDINGS) {
          if (sourceCrop || !cropTouchedEdge) break
          const retryBoxes = [
            neighborBoundedCropBoxes(
              segment.sourceBox,
              selectedLineIds,
              regions,
              padding,
            )[0],
            neighborBoundedCropBoxes(
              segment.sourceBox,
              selectedLineIds,
              regions,
              padding,
              PREFORMATTED_NEIGHBOR_GAP_FRACTION,
            )[0],
          ]
          for (const retryBox of retryBoxes) {
            if (
              attemptedBoxes.some((attempted) =>
                sameSourceBox(attempted, retryBox),
              )
            ) {
              continue
            }
            attemptedBoxes.push(retryBox)
            let retryTouchedEdge = false
            const retryCrop = await rasterizeFigure({
              kind: 'figure',
              page: segment.page,
              sourceBox: retryBox,
              sourceObjectIds,
              sourceBoxes: sourceObjectBoxes,
              tightenToSourceInk: false,
            }).catch((error: unknown) => {
              retryTouchedEdge = sourcePageCropTouchesEdge(error)
              return null
            })
            cropTouchedEdge = retryTouchedEdge
            if (retryCrop) {
              sourceCropBox = retryBox
              sourceCrop = retryCrop
              adaptivePaddingRetry = true
              break retryPreformattedCrop
            }
            if (!retryTouchedEdge) break retryPreformattedCrop
          }
        }
      }
      const cropMatched = Boolean(
        sourceCrop &&
        completeSourcePageCropAsset(
          sourceCrop,
          'figure',
          sourceObjectIds,
          sourceObjectBoxes,
          sourceCropBox,
        ),
      )
      if (!cropMatched || !sourceCrop) {
        allSegmentsMatched = false
        continue
      }
      renderedSegments.push({
        asset: sourceCrop,
        sourceObjectIds,
        sourceObjectBoxes,
        sourceCropBox,
        adaptivePaddingRetry,
      })
    }
    if (renderedSegments.length !== block.segments.length) {
      allSegmentsMatched = false
    }
    if (allSegmentsMatched) {
      for (const segment of renderedSegments) {
        mergeAsset(assetStore, segment.asset)
      }
    }
    block.caption.kind = 'caption'
    const consumedByRegion = new Map<string, string[]>()
    for (const { region, line } of block.sourceLines) {
      if (line.id === block.captionFallbackLineId) continue
      const values = consumedByRegion.get(region.id) ?? []
      values.push(line.id)
      consumedByRegion.set(region.id, values)
    }
    for (const [regionId, selectedLineIds] of consumedByRegion) {
      for (const lineId of selectedLineIds) consumedLineIds.add(lineId)
      consumeRegionLineSelection(
        regionId,
        selectedLineIds,
        regions,
        consumedRegionIds,
        consumedLineIds,
      )
    }
    const orderedSourceLines = [...block.sourceLines].sort(sourceLineOrder)
    const recoveredSourceText = orderedSourceLines
      .map(({ line }) => line.text)
      .join('\n')
    const sourceRegionIds = [
      ...new Set(orderedSourceLines.map(({ region }) => region.id)),
    ]
    const sourceLineIds = orderedSourceLines.map(({ line }) => line.id)
    const expectedSourceObjectIds = block.segments.flatMap(
      (segment, segmentIndex) =>
        segment.sourceObjectIds.length > 0
          ? segment.sourceObjectIds
          : [
              `code-source-p${String(segment.page).padStart(3, '0')}-${String(
                pageSequence,
              ).padStart(3, '0')}-${String(segmentIndex + 1).padStart(3, '0')}`,
            ],
    )
    const evidence = [
      ...block.evidence,
      ...(block.preformatted.status === 'unresolved'
        ? ['source-text-transcript-unresolved']
        : []),
      ...(renderedSegments.some((segment) => segment.adaptivePaddingRetry)
        ? ['source-page-crop-adaptive-padding']
        : []),
      ...(allSegmentsMatched
        ? ['source-page-crop']
        : ['source-rendition-unavailable', 'unresolved-visual-text-owned']),
    ]
    relationships.push({
      id: '',
      kind: 'figure',
      semanticKind: block.semanticKind,
      preformatted: block.preformatted,
      label: block.label,
      captionRegionId: block.caption.id,
      sourceRegionIds,
      sourceLineIds,
      sourceObjectIds: allSegmentsMatched ? expectedSourceObjectIds : [],
      assetIds: allSegmentsMatched
        ? renderedSegments.map((segment) => segment.asset.id)
        : [],
      status: allSegmentsMatched ? 'matched' : 'unresolved',
      confidence: Math.min(
        block.caption.confidence,
        ...block.sourceLines.map(({ region }) => region.confidence),
      ),
      evidence,
      candidates: [
        {
          sourceRegionIds,
          sourceObjectIds: expectedSourceObjectIds,
          assetIds: allSegmentsMatched
            ? renderedSegments.map((segment) => segment.asset.id)
            : [],
          score: block.caption.confidence,
          evidence,
          sourceBoxes: block.segments.map((segment) => segment.sourceBox),
        },
      ],
      sourceBoxes: [
        block.caption.box,
        ...block.segments.map((segment) => segment.sourceBox),
      ],
      sourceText:
        allSegmentsMatched && block.preformatted.status === 'unresolved'
          ? ''
          : recoveredSourceText,
      altText: retainedCaption,
      altTextSource: 'caption',
      canonicalNodeId: null,
      captionNodeId: null,
    })
    if (!allSegmentsMatched) {
      diagnostics.push({
        code: 'UNRESOLVED_PREFORMATTED_BLOCK',
        severity: 'error',
        page: block.caption.page,
        message: `${block.label} has a proved bounded source scope, but no complete exact source crop is available; its ordered lines were withheld from canonical prose.`,
        sourceBoxes: [
          block.caption.box,
          ...block.segments.map((segment) => segment.sourceBox),
        ],
        target: {
          regionIds: sourceRegionIds,
          markerId: null,
        },
      })
    }
  }

  await reconstructBoundedAlgorithms({
    regions,
    rasterizeFigure,
    assetStore,
    consumedRegionIds,
    consumedLineIds,
    relationships,
    diagnostics,
    onProgress,
    signal,
  })

  const equationCountByPage = new Map<number, number>()
  const equationComponents = await displayEquationComponents(
    regions,
    consumedRegionIds,
    onProgress,
    signal,
  )
  const equationComponentScopes = equationComponents.map((component, index) => {
    const id = `${component.source.id}\u001f${index}`
    return {
      id,
      component,
      ownership: proveEquationComponentOwnership(component.regions, regions),
    }
  })
  const equationComponentOwnershipByScopeId = new Map(
    equationComponentScopes.map((scope) => [scope.id, scope.ownership]),
  )
  const renderOnlyOwnershipByScopeId =
    proveEquationRenderOnlySourceRunOwnerships({
      pages,
      regions,
      scopes: equationComponentScopes.flatMap((scope) =>
        scope.ownership
          ? [
              {
                id: scope.id,
                page: scope.component.source.page,
                sourceRegionIds: scope.ownership.sourceRegionIds,
                sourceLineIds: scope.ownership.sourceLineIds,
              },
            ]
          : [],
      ),
    })
  const resolvedRenderOnlySourceRunKeys = new Set<string>()
  const componentEquationRegionIds = new Set(
    equationComponents.flatMap((component) =>
      component.regions
        .filter((region) => region.kind === 'equation')
        .map((region) => region.id),
    ),
  )
  for (const [
    equationIndex,
    { source, regions: sources },
  ] of equationComponents.entries()) {
    const equationComponentScopeId = `${source.id}\u001f${equationIndex}`
    if (
      equationIndex > 0 &&
      equationIndex % PDF_VISUAL_COOPERATIVE_BATCH_SIZE === 0
    ) {
      onProgress?.({
        phase: 'semantic-promotion',
        completed: equationIndex,
        total: equationComponents.length,
        message: `Resolving atomic display equations ${equationIndex} of ${equationComponents.length}…`,
      })
      await yieldPdfVisualTask(signal)
    }
    if (consumedRegionIds.has(source.id)) continue
    const page = pages.find((item) => item.page === source.page)
    if (!page) continue
    const renderVisibleTextRuns = sourceTextPaintInventoryForPage(page, regions)
    const sourceText = equationSourceText(sources)
    if (
      !probableDisplayEquationText(sourceText) &&
      !probableDisplayEquationText(equationSourceText([source])) &&
      !hasMathExtensionFontProvenance(source) &&
      !hasAmbiguousStackedEquationGeometry(sources) &&
      !sources.some(unresolvedMathExtensionRegion) &&
      !sources.some((region) => sourcePrintedEquationNumber(region) !== null)
    ) {
      continue
    }
    const ownership =
      equationComponentOwnershipByScopeId.get(equationComponentScopeId) ?? null
    const renderOnlyOwnershipProjection =
      renderOnlyOwnershipByScopeId.get(equationComponentScopeId) ?? null
    const sourceScopeComplete =
      ownership !== null &&
      !sources.some(unresolvedDetachedMathHost) &&
      completeEquationSourceScope(
        sources,
        regions,
        consumedRegionIds,
        componentEquationRegionIds,
      )
    const renderOnlyOwnedSourceRuns = sourceScopeComplete
      ? (renderOnlyOwnershipProjection?.sourceRuns ?? [])
      : []
    const renderOnlyOwnedRunKeys = new Set(
      renderOnlyOwnedSourceRuns.map(equationRenderOnlySourceRunIdentity),
    )
    const transcript = sourceScopeComplete
      ? sourceEquationTranscript(sources)
      : null
    const transcriptResolved = transcript !== null
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
    const transcriptEvidence = transcript
      ? transcript.evidence
      : ['source-text-transcript-unresolved']
    const approximationEvidence = [
      'source-equation-region',
      'bounded-source-geometry',
      ...(ownership ? ['source-proved-atomic-equation-component'] : []),
      ...transcriptEvidence,
      ...(!sourceScopeComplete ? ['incomplete-equation-source-scope'] : []),
      ...(sources.some(unresolvedDetachedMathHost)
        ? ['unresolved-detached-math-host']
        : []),
      ...(visualAsset ? ['readable-text-svg-approximation'] : []),
    ]
    const unboundedInitialCropBox = paddedUnionBox([sourceBox])
    const projectedSourceLineIds =
      ownership?.sourceLineIds ??
      sources.flatMap((region) => region.lines.map((line) => line.id))
    const sourceEquationLineIds = new Set(projectedSourceLineIds)
    const ownedSourceBoxes = [
      ...sources.flatMap((region) =>
        region.lines.flatMap((line) =>
          line.runs
            .filter((run) => run.text.trim())
            .map((run) => ({
              page: run.page,
              x: run.x,
              y: run.y,
              width: run.width,
              height: run.height,
              rotation: run.rotation,
              method: run.method,
            })),
        ),
      ),
      ...renderOnlyOwnedSourceRuns.map((run) => ({
        page: run.page,
        x: run.x,
        y: run.y,
        width: run.width,
        height: run.height,
        rotation: run.rotation,
        method: run.method,
      })),
    ]
    const overlappingUnownedSourceText = hasOverlappingUnownedEquationText(
      ownedSourceBoxes,
      sourceEquationLineIds,
      regions,
      renderVisibleTextRuns,
      renderOnlyOwnedRunKeys,
    )
    const sourceRegionIdSet = new Set(sources.map((region) => region.id))
    const hasNearbyUnownedEquationText = regions.some((candidate) => {
      if (
        sourceRegionIdSet.has(candidate.id) ||
        consumedRegionIds.has(candidate.id) ||
        candidate.page !== source.page ||
        candidate.text.trim().length === 0 ||
        printedEquationNumberFragment(candidate)
      ) {
        return false
      }
      const gap = boxGap(sourceBox, candidate.box)
      return (
        gap.vertical <= 0.03 &&
        gap.horizontal <= 0.12 &&
        ['body', 'spanning', 'side', 'equation'].includes(candidate.kind)
      )
    })
    if (overlappingUnownedSourceText) {
      approximationEvidence.push('overlapping-unowned-source-text')
    }
    let sourceCropBox = neighborBoundedCropBoxes(
      sourceBox,
      sourceEquationLineIds,
      regions,
      0.004,
    )[0]
    let sourceCrop: PdfVisualAsset | null = null
    let cropTouchedEdge = false
    let cropVetoedUnownedText = false
    let adaptivePaddingRetry = false
    let postExhaustionV2Retry = false
    let requestedExcludedSourceBoxes: NormalizedSourceBox[] = []
    let requestedTextOperationFilter: PdfTextOperationFilterPlan | null = null
    let retainedExcludedSourceBoxes: NormalizedSourceBox[] = []
    let neighborBoundedCrop = !sameSourceBox(
      sourceCropBox,
      unboundedInitialCropBox,
    )
    // A complete ownership proof is required for semantic promotion, but it
    // is not required to keep the equation readable. When the source box is
    // bounded and contains no unowned text, rasterize that exact box as a
    // source-preserved fallback instead of allowing its glyphs to fall into
    // ordinary prose. Contaminated/ambiguous boxes remain fail-closed.
    const sourcePreservedFallbackEligible =
      ownership !== null &&
      !sourceScopeComplete &&
      !overlappingUnownedSourceText &&
      !hasNearbyUnownedEquationText
    if (
      rasterizeFigure &&
      (sourceScopeComplete || sourcePreservedFallbackEligible)
    ) {
      const rasterizeEquationCrop = async (
        cropBox: NormalizedSourceBox,
        excludedSourceBoxes: readonly NormalizedSourceBox[],
        sourceTextOperationFilter: PdfTextOperationFilterPlan | null,
      ) => {
        const attempt = async (
          requestedExcludedSourceBoxes: readonly NormalizedSourceBox[],
        ) => {
          let touchedEdge = false
          const asset = await rasterizeFigure({
            kind: 'equation',
            page: source.page,
            sourceBox: cropBox,
            sourceObjectIds: [sourceObjectId],
            sourceBoxes: [sourceBox],
            ...(sourceTextOperationFilter
              ? { sourceTextOperationFilter }
              : { ownedSourceBoxes }),
            ...(!sourceTextOperationFilter &&
            requestedExcludedSourceBoxes.length > 0
              ? {
                  excludedSourceBoxes: [...requestedExcludedSourceBoxes],
                }
              : {}),
          }).catch((error: unknown) => {
            touchedEdge = sourcePageCropTouchesEdge(error)
            return null
          })
          return { asset, touchedEdge }
        }
        const maskedAttempt = await attempt(excludedSourceBoxes)
        if (
          maskedAttempt.asset &&
          !sourceTextOperationFilter &&
          excludedSourceBoxes.length > 0 &&
          !maskedAttempt.asset.sourceExclusionMask
        ) {
          // A renderer may prove that no pixels needed exclusion. Re-render
          // without the exclusion request before accepting that claim so a
          // dropped mask record cannot silently bless modified pixels.
          const cleanAttempt = await attempt([])
          return {
            crop: cleanAttempt.asset,
            touchedEdge: cleanAttempt.touchedEdge,
            requestedExcludedSourceBoxes: [] as NormalizedSourceBox[],
          }
        }
        return {
          crop: maskedAttempt.asset,
          touchedEdge: maskedAttempt.touchedEdge,
          requestedExcludedSourceBoxes: maskedAttempt.asset
            ? [...excludedSourceBoxes]
            : [],
        }
      }
      const initialUnownedSourceBoxes = unownedSourceTextBoxesInEquationCrop(
        sourceCropBox,
        sourceEquationLineIds,
        regions,
        renderVisibleTextRuns,
        renderOnlyOwnedRunKeys,
      )
      const initialHasUnownedText = initialUnownedSourceBoxes.length > 0
      const initialExcludedSourceBoxes = excludedEquationSourceBoxesForCrop(
        sourceCropBox,
        ownedSourceBoxes,
        sourceEquationLineIds,
        regions,
        page.width,
        page.height,
      )
      const initialExclusionsComplete = initialUnownedSourceBoxes.every(
        (unowned) =>
          initialExcludedSourceBoxes.some((excluded) =>
            sameSourceBox(unowned, excluded),
          ),
      )
      const initialV1Unsafe =
        initialHasUnownedText &&
        (!initialExclusionsComplete ||
          initialUnownedSourceBoxes.some((unowned) =>
            ownedSourceBoxes.some((owned) =>
              sourceBoxesIntersect(owned, unowned),
            ),
          ))
      const initialTextOperationFilter = initialV1Unsafe
        ? sourceTextOperationFilterPlanForEquationCrop(
            sourceCropBox,
            sourceEquationLineIds,
            regions,
            renderVisibleTextRuns,
            renderOnlyOwnedRunKeys,
          )
        : null
      cropVetoedUnownedText = initialV1Unsafe && !initialTextOperationFilter
      const initialCropResult = cropVetoedUnownedText
        ? null
        : await rasterizeEquationCrop(
            sourceCropBox,
            initialTextOperationFilter ? [] : initialExcludedSourceBoxes,
            initialTextOperationFilter,
          )
      sourceCrop = initialCropResult?.crop ?? null
      cropTouchedEdge = initialCropResult?.touchedEdge ?? false
      if (sourceCrop) {
        requestedTextOperationFilter = initialTextOperationFilter
        requestedExcludedSourceBoxes =
          initialCropResult!.requestedExcludedSourceBoxes
        retainedExcludedSourceBoxes =
          sourceCrop.sourceExclusionMask?.excludedSourceBoxes.map((box) => ({
            ...box,
          })) ?? []
      } else if (
        initialHasUnownedText &&
        !initialExclusionsComplete &&
        !initialTextOperationFilter
      ) {
        cropTouchedEdge = false
      }
      const attemptedBoxes = [sourceCropBox]
      const retryCropScopes = [
        ...EQUATION_SOURCE_CROP_RETRY_PADDINGS.map(
          (padding) => [padding, 0.25] as const,
        ),
        ...EQUATION_SOURCE_CROP_RETRY_NEIGHBOR_GAP_FRACTIONS.map(
          (neighborGapFraction) =>
            [
              EQUATION_SOURCE_CROP_RETRY_PADDINGS.at(-1)!,
              neighborGapFraction,
            ] as const,
        ),
      ]
      retryEquationCrop: for (const [
        padding,
        neighborGapFraction,
      ] of retryCropScopes) {
        if (sourceCrop || !cropTouchedEdge) break
        const retryBoxes = neighborBoundedCropBoxes(
          sourceBox,
          sourceEquationLineIds,
          regions,
          padding,
          neighborGapFraction,
        )
        for (const retryBox of retryBoxes) {
          if (
            attemptedBoxes.some((attempted) =>
              sameSourceBox(attempted, retryBox),
            )
          ) {
            continue
          }
          attemptedBoxes.push(retryBox)
          const retryUnownedSourceBoxes = unownedSourceTextBoxesInEquationCrop(
            retryBox,
            sourceEquationLineIds,
            regions,
            renderVisibleTextRuns,
            renderOnlyOwnedRunKeys,
          )
          const retryHasUnownedText = retryUnownedSourceBoxes.length > 0
          const retryExcludedSourceBoxes = excludedEquationSourceBoxesForCrop(
            retryBox,
            ownedSourceBoxes,
            sourceEquationLineIds,
            regions,
            page.width,
            page.height,
          )
          const retryExclusionsComplete = retryUnownedSourceBoxes.every(
            (unowned) =>
              retryExcludedSourceBoxes.some((excluded) =>
                sameSourceBox(unowned, excluded),
              ),
          )
          const retryV1Unsafe =
            retryHasUnownedText &&
            (!retryExclusionsComplete ||
              retryUnownedSourceBoxes.some((unowned) =>
                ownedSourceBoxes.some((owned) =>
                  sourceBoxesIntersect(owned, unowned),
                ),
              ))
          const retryTextOperationFilter = retryV1Unsafe
            ? sourceTextOperationFilterPlanForEquationCrop(
                retryBox,
                sourceEquationLineIds,
                regions,
                renderVisibleTextRuns,
                renderOnlyOwnedRunKeys,
              )
            : null
          if (retryV1Unsafe && !retryTextOperationFilter) {
            cropVetoedUnownedText = true
            continue
          }
          const retryResult = await rasterizeEquationCrop(
            retryBox,
            retryTextOperationFilter ? [] : retryExcludedSourceBoxes,
            retryTextOperationFilter,
          )
          const retryCrop = retryResult.crop
          cropTouchedEdge = retryResult.touchedEdge
          if (retryCrop) {
            sourceCropBox = retryBox
            sourceCrop = retryCrop
            requestedTextOperationFilter = retryTextOperationFilter
            requestedExcludedSourceBoxes =
              retryResult.requestedExcludedSourceBoxes
            retainedExcludedSourceBoxes =
              retryCrop.sourceExclusionMask?.excludedSourceBoxes.map((box) => ({
                ...box,
              })) ?? []
            adaptivePaddingRetry = true
            neighborBoundedCrop = true
            break retryEquationCrop
          }
          if (!cropTouchedEdge) break retryEquationCrop
        }
      }
      if (!sourceCrop && (cropTouchedEdge || cropVetoedUnownedText)) {
        for (const padding of EQUATION_SOURCE_CROP_RETRY_PADDINGS) {
          const postExhaustionBox = paddedEquationCropBox(sourceBox, padding)
          if (
            attemptedBoxes.some((attempted) =>
              sameSourceBox(attempted, postExhaustionBox),
            ) ||
            !isBoundedPdfPageCropBox(postExhaustionBox) ||
            !fullyContainsBox(
              postExhaustionBox,
              sourceBox,
              SOURCE_CROP_CONTAINMENT_TOLERANCE,
            )
          ) {
            continue
          }
          const postExhaustionTextOperationFilter =
            sourceTextOperationFilterPlanForEquationCrop(
              postExhaustionBox,
              sourceEquationLineIds,
              regions,
              renderVisibleTextRuns,
              renderOnlyOwnedRunKeys,
            )
          if (
            !postExhaustionTextOperationFilter ||
            postExhaustionTextOperationFilter.algorithm !==
              'pdfjs-display-text-operation-filter-v2' ||
            !postExhaustionTextOperationFilter.ownedSourceBoxes.every((box) =>
              fullyContainsBox(
                postExhaustionBox,
                box,
                SOURCE_CROP_CONTAINMENT_TOLERANCE,
              ),
            )
          ) {
            continue
          }
          attemptedBoxes.push(postExhaustionBox)
          const postExhaustionResult = await rasterizeEquationCrop(
            postExhaustionBox,
            [],
            postExhaustionTextOperationFilter,
          )
          cropTouchedEdge = postExhaustionResult.touchedEdge
          if (postExhaustionResult.crop) {
            sourceCropBox = postExhaustionBox
            sourceCrop = postExhaustionResult.crop
            requestedTextOperationFilter = postExhaustionTextOperationFilter
            requestedExcludedSourceBoxes = []
            retainedExcludedSourceBoxes =
              sourceCrop.sourceExclusionMask?.excludedSourceBoxes.map(
                (box) => ({ ...box }),
              ) ?? []
            adaptivePaddingRetry = true
            postExhaustionV2Retry = true
            neighborBoundedCrop = false
            break
          }
          if (!cropTouchedEdge) break
        }
      }
    }
    if (cropVetoedUnownedText) {
      approximationEvidence.push('source-page-crop-vetoed-unowned-text')
    }
    const cropMatched = Boolean(
      sourceCrop &&
      completeSourcePageCropAsset(
        sourceCrop,
        'equation',
        [sourceObjectId],
        [sourceBox],
        sourceCropBox,
        ownedSourceBoxes,
        requestedExcludedSourceBoxes,
        requestedTextOperationFilter,
      ),
    )
    const appliedRenderOnlyOwnerships = cropMatched
      ? (renderOnlyOwnershipProjection?.ownerships ?? [])
      : []
    if (cropMatched) {
      for (const run of renderOnlyOwnedSourceRuns) {
        resolvedRenderOnlySourceRunKeys.add(
          equationRenderOnlySourceRunIdentity(run),
        )
      }
    }
    if (sourceCrop && cropMatched) mergeAsset(assetStore, sourceCrop)
    const fallbackOwnership = ownership
    const equationGeometryTranscript =
      cropMatched && sourceCrop && transcript === null && fallbackOwnership
        ? createSourceGeometryScriptTranscript({
            sourceRegionIds: fallbackOwnership.sourceRegionIds,
            sourceLineIds: fallbackOwnership.sourceLineIds,
            sourceObjectIds: [sourceObjectId],
            regions,
            sourceCropAsset: sourceCrop,
          })
        : null
    const resolvedTranscriptEvidence = equationGeometryTranscript
      ? [SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE]
      : transcriptEvidence
    const evidence = cropMatched
      ? [
          'source-equation-region',
          'bounded-source-geometry',
          ...(sourceScopeComplete
            ? ['source-proved-atomic-equation-component']
            : ['source-preserved-equation-fallback']),
          ...resolvedTranscriptEvidence,
          ...(adaptivePaddingRetry
            ? ['source-page-crop-adaptive-padding']
            : []),
          ...(postExhaustionV2Retry
            ? ['source-page-crop-post-exhaustion-v2']
            : []),
          ...(neighborBoundedCrop ? ['source-page-crop-neighbor-bounded'] : []),
          ...(retainedExcludedSourceBoxes.length > 0 &&
          sourceCrop?.sourceExclusionMask?.algorithm === 'nearest-source-box-v1'
            ? ['source-page-crop-unowned-text-masked']
            : []),
          ...(requestedTextOperationFilter
            ? ['source-page-crop-text-operation-filter-attested']
            : []),
          ...(appliedRenderOnlyOwnerships.length > 0
            ? [RENDER_ONLY_EQUATION_OWNERSHIP_EVIDENCE]
            : []),
          'source-page-crop',
        ]
      : approximationEvidence
    // Exact source identity proves which regions form this equation, but it
    // does not prove that their text has a canonical replacement. Preserve
    // every source line when the rendition is unresolved; otherwise an
    // unavailable crop can silently turn source equations (and adjacent
    // inline obligations) into missing content.
    if (cropMatched) {
      for (const attached of sources) {
        if (attached.id === source.id) continue
        consumeRegionLineSelection(
          attached.id,
          attached.lines.map((line) => line.id),
          regions,
          consumedRegionIds,
          consumedLineIds,
        )
      }
    }
    const relationshipEvidence = cropMatched
      ? evidence
      : [...evidence, 'source-rendition-unavailable']
    relationships.push({
      id: '',
      kind: 'equation',
      label,
      // Keep the primary equation region in reading order so layout can turn
      // its source text into the typed caption for this atomic obligation.
      captionRegionId: source.id,
      sourceRegionIds: fallbackOwnership?.sourceRegionIds ?? [],
      sourceLineIds: fallbackOwnership?.sourceLineIds ?? [],
      sourceObjectIds: cropMatched ? [sourceObjectId] : [],
      assetIds: cropMatched ? [sourceCrop!.id] : [],
      status: cropMatched ? 'matched' : 'unresolved',
      confidence: source.confidence,
      evidence: relationshipEvidence,
      candidates: [
        {
          sourceRegionIds:
            fallbackOwnership?.sourceRegionIds ??
            sources.map((region) => region.id),
          ...(fallbackOwnership
            ? {
                sourceLineIds: fallbackOwnership.sourceLineIds,
                sourceText,
                ownershipExtentSha256: pdfVisualOwnershipExtentSha256(
                  regions,
                  fallbackOwnership.sourceRegionIds,
                  fallbackOwnership.sourceLineIds,
                ),
                ...(appliedRenderOnlyOwnerships.length > 0
                  ? {
                      renderOnlySourceRunOwnerships:
                        appliedRenderOnlyOwnerships,
                    }
                  : {}),
              }
            : {}),
          sourceObjectIds: [sourceObjectId],
          assetIds: cropMatched
            ? [sourceCrop!.id]
            : visualAsset
              ? [visualAsset.id]
              : [],
          score: source.confidence,
          evidence: relationshipEvidence,
          sourceBoxes: [sourceBox],
        },
      ],
      sourceBoxes: sources.map((region) => region.box),
      ...(equationGeometryTranscript ? { equationGeometryTranscript } : {}),
      ...(appliedRenderOnlyOwnerships.length > 0
        ? { renderOnlySourceRunOwnerships: appliedRenderOnlyOwnerships }
        : {}),
      sourceText: transcript?.text ?? '',
      altText: transcript?.text ?? label,
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
          : overlappingUnownedSourceText
            ? `${label} has source geometry that materially overlaps unowned text, so no contaminated rectangular crop was retained.`
            : !sourceScopeComplete
              ? `${label} has an incomplete or ambiguously owned adjacent equation source scope, so no partial glyph crop was retained.`
              : `${label} has bounded source geometry but its extracted semantic transcript is unresolved and no source glyph raster is available.`,
        sourceBoxes: sources.map((region) => region.box),
        target: {
          regionIds: sources.map((region) => region.id),
          markerId: null,
        },
      })
    }
  }

  for (const run of unresolvedExtensionTextItems) {
    if (
      resolvedRenderOnlySourceRunKeys.has(
        equationRenderOnlySourceRunIdentity(run),
      )
    ) {
      continue
    }
    const regionIds = regions
      .filter(
        (region) =>
          region.page === run.page &&
          Math.min(region.box.x + region.box.width, run.x + run.width) >
            Math.max(region.box.x, run.x) &&
          Math.min(region.box.y + region.box.height, run.y + run.height) >
            Math.max(region.box.y, run.y),
      )
      .map((region) => region.id)
      .sort()
    diagnostics.push({
      code: 'UNRESOLVED_VISUAL_OBJECT',
      severity: 'error',
      page: run.page,
      message:
        'An extension-font PDF text item decoded from unattested whitespace has no publishable semantic transcript; its exact source box remains a visual review obligation.',
      sourceBoxes: [
        {
          page: run.page,
          x: run.x,
          y: run.y,
          width: run.width,
          height: run.height,
          rotation: run.rotation,
          method: run.method,
        },
      ],
      target: { regionIds, markerId: null },
    })
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
    for (const candidate of relationship.candidates) {
      candidate.id = pdfVisualMatchCandidateId(relationship.id, candidate)
    }
    const canonicalPage =
      regions.find((region) => region.id === relationship.captionRegionId)
        ?.page ?? relationship.sourceBoxes[0]?.page
    relationship.canonicalNodeId =
      relationship.status === 'matched' &&
      typeof canonicalPage === 'number' &&
      Number.isSafeInteger(canonicalPage) &&
      canonicalPage > 0
        ? visualCanonicalNodeId(relationship, canonicalPage)
        : null
    if (relationship.status !== 'matched') {
      const diagnostic = diagnostics.find(
        (candidate) =>
          (candidate.code === 'AMBIGUOUS_VISUAL_MATCH' ||
            candidate.code === 'UNRESOLVED_VISUAL_OBJECT') &&
          candidate.target?.markerId === null &&
          candidate.target.regionIds.includes(relationship.captionRegionId),
      )
      if (diagnostic?.target) diagnostic.target.markerId = relationship.id
    }
  }

  const directlyReferencedObjectIds = new Set(
    relationships.flatMap((relationship) => relationship.sourceObjectIds),
  )
  const exactFigureCropOwners = relationships.flatMap((relationship) => {
    if (
      relationship.kind !== 'figure' ||
      relationship.status !== 'matched' ||
      !relationship.captionRegionId
    ) {
      return []
    }
    const caption = regions.find(
      (region) => region.id === relationship.captionRegionId,
    )
    if (!caption) return []
    return relationship.assetIds.flatMap((assetId) => {
      const asset = assetStore.get(assetId)
      const ownedSourceBoxes = relationship.sourceBoxes.slice(1)
      return asset?.rendition === 'source-page-crop' &&
        asset.sourceCropBox &&
        ownedSourceBoxes.length > 0
        ? [
            {
              relationship,
              caption,
              sourceCropBox: asset.sourceCropBox,
              ownerSourceBox: paddedUnionBox(ownedSourceBoxes),
            },
          ]
        : []
    })
  })
  const exactCropCreditedNativeObjectIds = new Set<string>()
  for (const object of pages.flatMap((page) => page.objects ?? [])) {
    if (
      object.role === 'scan-source' ||
      decorativeObjectIds.has(object.id) ||
      directlyReferencedObjectIds.has(object.id)
    ) {
      continue
    }
    const owners = exactFigureCropOwners.filter((owner) =>
      exactCropUniquelyOwnsNativeObject({
        sourceCropBox: owner.sourceCropBox,
        ownerSourceBox: owner.ownerSourceBox,
        objectBox: object.box,
        ownerCaption: owner.caption,
        figureCaptions,
      }),
    )
    if (owners.length !== 1) continue
    exactCropCreditedNativeObjectIds.add(object.id)
    if (
      !owners[0].relationship.evidence.includes(
        'source-page-crop-native-object-credit',
      )
    ) {
      owners[0].relationship.evidence.push(
        'source-page-crop-native-object-credit',
      )
    }
  }

  const referenced = new Set([
    ...exactCropCreditedNativeObjectIds,
    ...relationships.flatMap((relationship) => [
      ...relationship.sourceObjectIds,
      ...(relationship.status === 'matched'
        ? []
        : relationship.candidates.flatMap(
            (candidate) => candidate.sourceObjectIds,
          )),
    ]),
  ])
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
    remoteTableCandidateUsed,
    ...(tableCandidateProvider ? { tableCandidateReceipts } : {}),
  }
}
