import type {
  NormalizedSourceBox,
  PdfImportProgress,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceRun,
  PdfVisualAsset,
  PdfVisualRelationship,
  ReconstructionDiagnostic,
} from './import-types'
import { sourceMathFontProvenance } from './pdf-equation-source-math'
import {
  provedProseSplitInlineStackedFormulaBaseIds,
  sourceMathFragment,
} from './pdf-equation-fragment-evidence'
import { equationSourceText } from './pdf-equation-transcript'
import {
  exactCropUniquelyOwnsNativeObject,
  hasMathExtensionFontProvenance,
  isProbableDisplayEquation,
  probableDisplayEquationText,
  sourceEquationRendition,
  sourcePrintedEquationNumber,
} from './pdf-equation-display-evidence'
import {
  attachedEquationRegions,
  consumeRegionLineSelection,
} from './pdf-equation-components'
import { reconstructDisplayEquations } from './pdf-equation-reconstruction'
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
  type ParsedPdfScholarlyVisualLabel,
} from './pdf-scholarly-label'
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
  mergePdfVisualAsset as mergeAsset,
  samePdfSourceBox as sameSourceBox,
  sourcePageCropFailureEvidence,
  sourcePageCropTouchesEdge,
  sourcePageCropValidationFailure,
  withSourceCropAttemptProvenance,
} from './pdf-visual-source-crops'
import {
  captionLaneHorizontalBounds,
  captionLaneScopedRenderBox,
  captionSourceLaneMatches,
  captionSourceLaneMatchesBox,
  compatibleCaptionLaneColumns,
  compositeCandidateMayCrossCaptionLane,
  horizontalBoxOverlap,
  matchCandidate,
  matchRecord,
  MIN_CROSS_COLUMN_FIGURE_SPAN,
  pdfVisualMatchCandidateId,
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
  paddedUnionBox,
  TABLE_SOURCE_CROP_RETRY_PADDINGS,
  tableRowBandCount,
  tableSourceCropRetryPaddings,
  unionBox,
} from './pdf-visual-source-geometry'
import {
  CAPTION_BOUNDED_PANEL_BOTTOM_INSET,
  captionBoundedPanelRecoveryBoxes,
  captionTextBoundedFigureRetryBox,
  connectedFigureReservationContestedByTableCaption,
  connectedFigureReservationLineage,
  containedFigureOverlayLineage,
  intersectSourceBox,
  MIN_COMPOSITE_FIGURE_FRAGMENTS,
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
  containsCenter,
  figureRegionSpatialIndex,
  isLargeVectorArtifact,
  MAX_SINGLE_COLUMN_FIGURE_WIDTH,
  PDF_VISUAL_COOPERATIVE_BATCH_SIZE,
  throwIfPdfVisualWorkAborted,
  yieldPdfVisualTask,
  type PdfFigureGroupingEvidence,
} from './pdf-visual-figure-grouping'
import {
  CAPTION_ENVELOPE_SOURCE_CROP_RETRY_PADDINGS,
  MAX_REUSED_PAGE_BACKDROP_EDGE_INSET,
  textOverlayId,
} from './pdf-visual-caption-envelopes'
import {
  reconstructBoundedAlgorithms,
  type PdfFigureRasterizer as PdfFigureRasterizerContract,
} from './pdf-visual-algorithms'
import {
  figureCandidates,
  sourcePreservedFigureFallbackCandidate,
} from './pdf-visual-figure-candidates'
import {
  detectPreformattedVisuals,
  reconstructPreformattedVisuals,
} from './pdf-visual-preformatted'
export {
  decorativeNativeObjectIds,
  repeatedRectangleFallbackObjectIds,
  type PdfRectangleIndexEvidence,
} from './pdf-visual-native-artifacts'
export { hasUnprovedTwoDimensionalEquationTranscript } from './pdf-equation-transcript'
export { isProbableDisplayEquation } from './pdf-equation-display-evidence'
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

const MIN_REUSED_PAGE_BACKDROP_WIDTH = 0.6
const MIN_REUSED_PAGE_BACKDROP_HEIGHT = 0.2
const MIN_REUSED_PANEL_CLIP_WIDTH = 0.4
const MIN_REUSED_PANEL_CLIP_HEIGHT = 0.15
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
  const {
    blocks: preformattedBlocks,
    captionRegionIds: preformattedCaptionRegionIds,
  } = detectPreformattedVisuals({
    pages,
    regions,
    captionLabels,
    diagnostics,
    scopeEvidence: {
      hasMathExtensionFontProvenance,
      sourceMathFragment,
      dedicatedCaptionLabelStyle,
      unstyledProseTableReference,
    },
  })
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
      { isProbableDisplayEquation, sourcePrintedEquationNumber },
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

  await reconstructPreformattedVisuals({
    preformattedBlocks,
    regions,
    rasterizeFigure,
    assetStore,
    consumedRegionIds,
    consumedLineIds,
    relationships,
    diagnostics,
    consumeRegionLineSelection,
    onProgress,
    signal,
  })

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

  await reconstructDisplayEquations({
    pages,
    regions,
    rasterizeFigure,
    assetStore,
    consumedRegionIds,
    consumedLineIds,
    relationships,
    diagnostics,
    unresolvedExtensionTextItems,
    onProgress,
    signal,
  })

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
