import type {
  NormalizedSourceBox,
  PdfImportProgress,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfPreformattedSource,
  PdfPreformattedSourceLine,
  PdfRegionLine,
  PdfRegionColumn,
  PdfSourceRun,
  PdfSourceCropAttempt,
  PdfSourceCropAttemptRequest,
  PdfTextOperationFilterPlan,
  PdfVisualAsset,
  PdfVisualMatchCandidate,
  PdfVisualRelationship,
  ReconstructionDiagnostic,
} from './import-types'
import { PdfImportError } from './import-types'
import {
  createSourceGeometryScriptTranscript,
  SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE,
} from './equation-geometry-transcript'
import {
  equationRenderOnlySourceRunIdentity,
  proveEquationRenderOnlySourceRunOwnerships,
  RENDER_ONLY_EQUATION_OWNERSHIP_EVIDENCE,
} from './equation-render-only-ownership'
import { pdfFontTextRequiresStructuralReconstruction } from './pdf-font-text'
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
  parsePdfScholarlyVisualLabel,
  type PdfScholarlyVisualLabel,
  type ParsedPdfScholarlyVisualLabel,
} from './pdf-scholarly-label'
import { proseDominantPdfMathSource } from './pdf-regions'
import { isBoundedPdfPageCropBox } from './pdf-page-crop'
import { mergePdfRunText } from './pdf-lines'
import {
  canonicalTableFromLines,
  createHeadlessCompositePngAsset,
  createHeadlessCompositeSvgAsset,
  createTableAsset,
  createTextSvgAsset,
  isValidSourcePageCropPayload,
  isCanonicalPdfSourceExclusionMask,
  isTrustedPdfTextOperationFilterAsset,
  pdfSourceExclusionMaskIdentity,
  type CanonicalTable,
} from './visual-assets'
import { sanitizeXmlText } from './publication-integrity'
import { sha256HexSync } from './sha256-sync'
import { PDFJS_DISPLAY_OPERATOR_ADAPTER } from './pdf-text-paint'
import {
  runTableCandidateProvider,
  type TableCandidateProvider,
  type TableCandidateReceipt,
} from './table-candidate-provider'

type VisualKind = PdfVisualRelationship['kind']
type PdfNativeObject = NonNullable<PdfPageAnalysis['objects']>[number]
type DetectedPdfTable = NonNullable<ReturnType<typeof detectTableNearCaption>>

type CompleteSemanticTableScope = {
  sourceHeaderLineIds: string[]
  evidence: string[]
}

export const VISUAL_MATCH_DECISION_SCHEMA_VERSION = '1.3.0' as const
// Version candidate identity independently from the human-decision file.
// Existing v1.3 files still parse, but IDs produced by earlier algorithms
// fail stale rather than replaying against a different ownership extent.
const VISUAL_MATCH_CANDIDATE_IDENTITY_VERSION = '3.0.0' as const

function visualCanonicalSlug(value: string, maximum = 36) {
  return (
    value
      .toLocaleLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, maximum) || 'content'
  )
}

export function visualCanonicalNodeId(
  relationship: PdfVisualRelationship,
  page: number,
) {
  const sourceAnchor =
    relationship.sourceObjectIds[0] ??
    relationship.sourceRegionIds[0] ??
    relationship.captionRegionId
  return [
    'visual',
    relationship.kind,
    `p${String(page).padStart(3, '0')}`,
    visualCanonicalSlug(relationship.label, 24),
    visualCanonicalSlug(sourceAnchor, 40),
    visualCanonicalSlug(relationship.id, 32),
  ].join('-')
}

type PdfVisualMatchCandidateIdentityInput = Pick<
  PdfVisualMatchCandidate,
  | 'sourceRegionIds'
  | 'sourceObjectIds'
  | 'assetIds'
  | 'sourceBoxes'
  | 'renderOnlySourceRunOwnerships'
> & {
  sourceLineIds?: readonly string[]
  sourceText?: string
  ownershipExtentSha256?: string
}

export function pdfVisualMatchCandidateId(
  relationshipId: string,
  candidate: PdfVisualMatchCandidateIdentityInput,
) {
  const sourceLineIds = [...(candidate.sourceLineIds ?? [])].sort()
  const legacyIdentity = {
    schemaVersion: VISUAL_MATCH_DECISION_SCHEMA_VERSION,
    relationshipId,
    sourceRegionIds: [...candidate.sourceRegionIds].sort(),
    assetIds: [...candidate.assetIds].sort(),
  }
  const identity = JSON.stringify({
    ...legacyIdentity,
    candidateIdentityVersion: VISUAL_MATCH_CANDIDATE_IDENTITY_VERSION,
    sourceLineIds,
    sourceLineage: Array.from(
      {
        length: Math.max(
          candidate.sourceObjectIds.length,
          candidate.sourceBoxes.length,
        ),
      },
      (_unused, index) =>
        JSON.stringify({
          sourceObjectId: candidate.sourceObjectIds[index] ?? null,
          sourceBox: candidate.sourceBoxes[index]
            ? {
                page: candidate.sourceBoxes[index].page,
                x: candidate.sourceBoxes[index].x,
                y: candidate.sourceBoxes[index].y,
                width: candidate.sourceBoxes[index].width,
                height: candidate.sourceBoxes[index].height,
                rotation: candidate.sourceBoxes[index].rotation,
                method: candidate.sourceBoxes[index].method,
              }
            : null,
        }),
    ).sort(),
    ownershipExtentSha256: candidate.ownershipExtentSha256 ?? null,
    sourceText: candidate.sourceText ?? '',
    renderOnlySourceRunOwnerships:
      candidate.renderOnlySourceRunOwnerships ?? [],
  })
  return `visual-candidate-${sha256HexSync(identity)}`
}

export type PdfFigureRasterizer = (
  input: PdfSourceCropAttemptRequest,
) => Promise<PdfVisualAsset | null>

export type PdfPartialRegionLineSelection = {
  regionId: string
  consumedLineIds: string[]
  retainedLineIds: string[]
}

const MIN_COMPOSITE_FIGURE_FRAGMENTS = 2
const TEXT_OVERLAY_PREFIX = 'text-overlay:'
const FIGURE_OVERLAY_BOX_TOLERANCE = 0.004
const MIN_FIGURE_OVERLAY_RENDER_CONTAINMENT = 0.95
const MIN_ADJACENT_PANEL_FIGURE_SPAN = 0.6
// Diagram labels must remain outside canonical reading order and subordinate
// to the established native render scope. The area cap is a secondary bound;
// individually small fragments are not evidence that canonical prose is safe.
const MAX_FIGURE_TEXT_OVERLAY_AREA_RATIO = 0.2
const MAX_CAPTION_BOUNDED_FLOW_OVERLAY_AREA_RATIO = 0.45
const MAX_LAYERED_PANEL_FLOW_OVERLAY_AREA_RATIO = 0.9
const MIN_CAPTION_BOUNDED_FLOW_OVERLAY_LINE_COUNT = 2
const MAX_SINGLE_LINE_CHART_OVERLAY_CHARACTERS = 48
const MAX_SINGLE_LINE_CHART_OVERLAY_AREA_RATIO = 0.03
const MIN_DENSE_NATIVE_SCAFFOLD_FRAGMENT_COUNT = 8
const MIN_NATIVE_SCAFFOLD_AREA = 0.04
const MIN_COEXTENSIVE_NATIVE_LAYER_OVERLAP = 0.9
const MIN_REUSED_PAGE_BACKDROP_WIDTH = 0.6
const MIN_REUSED_PAGE_BACKDROP_HEIGHT = 0.2
const MAX_REUSED_PAGE_BACKDROP_EDGE_INSET = 0.02
const MIN_REUSED_PANEL_CLIP_WIDTH = 0.4
const MIN_REUSED_PANEL_CLIP_HEIGHT = 0.15
const MIN_REPEATED_RECTANGLE_OVERLAP = 0.98
const MIN_EXACT_CROP_NATIVE_OBJECT_CONTAINMENT = 0.99
const SOURCE_CROP_CONTAINMENT_TOLERANCE = 0.00001
const CAPTION_BOUNDED_PANEL_EDGE_RETRY_PADDING = 0.012
const CAPTION_BOUNDED_PANEL_HORIZONTAL_EDGE_RETRY_PADDING = 0.018
const CAPTION_BOUNDED_PANEL_BOTTOM_INSET = 0.008
const MAX_CAPTION_BOUNDED_PANEL_RECOVERY_ATTEMPTS = 8
const CAPTION_ENVELOPE_SOURCE_CROP_RETRY_PADDINGS = [
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
const MIN_CROSS_COLUMN_FIGURE_SPAN = 0.65
const MAX_SINGLE_COLUMN_FIGURE_WIDTH = 0.55
const MAX_ADJACENT_PANEL_GAP = 0.1
const PDF_VISUAL_COOPERATIVE_BATCH_SIZE = 8
const PDF_VISUAL_INDEX_COOPERATIVE_BATCH_SIZE = 64

function throwIfPdfVisualWorkAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return
  throw new PdfImportError(
    'IMPORT_CANCELLED',
    'The local PDF reconstruction was cancelled and its working data was released.',
  )
}

async function yieldPdfVisualTask(signal?: AbortSignal) {
  throwIfPdfVisualWorkAborted(signal)
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
  throwIfPdfVisualWorkAborted(signal)
}
const MAX_TABLE_HEADER_SCOPE_GAP = 0.025
const MIN_TABLE_HEADER_HORIZONTAL_COVERAGE = 0.5
const MAX_DISPLAY_EQUATION_WIDTH = 0.82
const ALGORITHM_SOURCE_CROP_PADDING = 0.012
const ALGORITHM_SOURCE_CROP_RETRY_PADDINGS = [
  0.014, 0.016, 0.02, 0.024, 0.028,
] as const
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
const EQUATION_EXCLUDED_TEXT_MASK_PIXELS = 2
const EQUATION_EXCLUDED_TEXT_MAX_RENDER_SCALE = 3
const MAX_EQUATION_EXCLUDED_SOURCE_BOXES = 32
const MAX_EQUATION_OWNED_SOURCE_BOXES = 256
const MAX_EQUATION_TEXT_LEDGER_SPANS = 256
const TABLE_SOURCE_CROP_RETRY_PADDINGS = [
  0.006, 0.008, 0.01, 0.012, 0.014, 0.016, 0.02, 0.024, 0.028, 0.032,
] as const
const TABLE_SOURCE_CROP_RELATIVE_RETRY_FRACTIONS = [
  0.1, 0.15, 0.2, 0.25,
] as const
const TABLE_SOURCE_CROP_NEIGHBOR_GAP_FRACTIONS = [0.25, 0.5, 0.75, 0.9] as const

type VisualCandidate = {
  kind: VisualKind
  captionRegionId?: string
  sourceRegionIds: string[]
  sourceLineIds?: string[]
  sourceObjectIds: string[]
  assetIds: string[]
  sourceBoxes: NormalizedSourceBox[]
  sourceText: string
  page: number
  column: PdfPageRegion['column']
  renderBox?: NormalizedSourceBox
  textOwnershipBox?: NormalizedSourceBox
  evidence?: string[]
  sourcePageCropBlockedByReadingOrderText?: boolean
  nativeEnvelopeIncomplete?: boolean
  tableRegionLineage?: PdfTableScope['regionLineage']
}

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

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

function compatibleCaptionLaneColumns(
  left: PdfPageRegion['column'],
  right: PdfPageRegion['column'],
) {
  return left === right || left === 'span' || right === 'span'
}

function captionSourceLaneMatches(
  caption: PdfPageRegion,
  region: PdfPageRegion,
) {
  return captionSourceLaneMatchesBox(caption, region.box, region.column)
}

function captionSourceLaneMatchesBox(
  caption: PdfPageRegion,
  sourceBox: NormalizedSourceBox,
  sourceColumn: PdfPageRegion['column'],
) {
  const lane = caption.sourceCaptionLane
  if (!lane) {
    return compatibleCaptionLaneColumns(sourceColumn, caption.column)
  }
  const left = sourceBox.x
  const right = sourceBox.x + sourceBox.width
  const tolerance = FIGURE_OVERLAY_BOX_TOLERANCE
  if (left < lane.boundary - tolerance && right > lane.boundary + tolerance) {
    return false
  }
  const center = left + sourceBox.width / 2
  return lane.side === 'left'
    ? center <= lane.boundary + tolerance
    : center >= lane.boundary - tolerance
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

function singleSolidRectangleFallbackAsset(asset: PdfVisualAsset | undefined) {
  if (
    !asset ||
    asset.kind !== 'vector' ||
    asset.mediaType !== 'image/svg+xml' ||
    asset.rendition !== 'bounded-svg-fallback'
  ) {
    return false
  }
  const svg = new TextDecoder().decode(asset.bytes)
  const paths = [...svg.matchAll(/<path\b([^>]*)\/?>/giu)]
  if (
    paths.length !== 1 ||
    /<(?:circle|ellipse|image|line|polygon|polyline|rect|text|use)\b/iu.test(
      svg,
    )
  ) {
    return false
  }
  const attributes = paths[0][1]
  const fill = attributes.match(/\bfill=(["'])(.*?)\1/iu)?.[2]?.trim()
  const stroke = attributes.match(/\bstroke=(["'])(.*?)\1/iu)?.[2]?.trim()
  const path = attributes.match(/\bd=(["'])(.*?)\1/iu)?.[2]?.trim()
  if (!path || !fill || fill === 'none' || stroke !== 'none') return false

  const tokens =
    path.match(/[MLZ]|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/giu) ?? []
  if (tokens.join(' ').replace(/\s+/g, '') !== path.replace(/\s+/g, '')) {
    return false
  }
  const points: Array<{ x: number; y: number }> = []
  let command = ''
  let index = 0
  let closed = false
  while (index < tokens.length) {
    const token = tokens[index++]
    if (/^[MLZ]$/iu.test(token)) {
      command = token.toUpperCase()
      if (command === 'Z') {
        closed = index === tokens.length
        continue
      }
    } else {
      index -= 1
    }
    if (!['M', 'L'].includes(command) || index + 1 >= tokens.length) {
      return false
    }
    const x = Number(tokens[index++])
    const y = Number(tokens[index++])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    points.push({ x, y })
  }
  if (!closed || points.length < 4 || points.length > 5) return false
  if (
    points.length === 5 &&
    points[0].x === points[4].x &&
    points[0].y === points[4].y
  ) {
    points.pop()
  }
  if (points.length !== 4) return false
  const xs = [...new Set(points.map((point) => point.x))].sort(
    (left, right) => left - right,
  )
  const ys = [...new Set(points.map((point) => point.y))].sort(
    (left, right) => left - right,
  )
  if (xs.length !== 2 || ys.length !== 2) return false
  const corners = new Set(points.map((point) => `${point.x}:${point.y}`))
  if (corners.size !== 4) return false
  return points.every((point, pointIndex) => {
    const next = points[(pointIndex + 1) % points.length]
    return point.x === next.x || point.y === next.y
  })
}

export type PdfRectangleIndexEvidence = {
  candidateComparisons: number
}

const REPEATED_RECTANGLE_GEOMETRY_TOLERANCE = 0.004
const REPEATED_RECTANGLE_SPATIAL_CELL_SIZE = 0.05

function rectangleGeometryCell(object: PdfNativeObject) {
  return [object.box.x, object.box.y, object.box.width, object.box.height]
    .map((value) => Math.floor(value / REPEATED_RECTANGLE_GEOMETRY_TOLERANCE))
    .join(':')
}

function neighboringRectangleGeometryCells(object: PdfNativeObject) {
  const base = [
    object.box.x,
    object.box.y,
    object.box.width,
    object.box.height,
  ].map((value) => Math.floor(value / REPEATED_RECTANGLE_GEOMETRY_TOLERANCE))
  const keys: string[] = []
  for (let x = -1; x <= 1; x += 1) {
    for (let y = -1; y <= 1; y += 1) {
      for (let width = -1; width <= 1; width += 1) {
        for (let height = -1; height <= 1; height += 1) {
          keys.push(
            `${base[0] + x}:${base[1] + y}:${base[2] + width}:${base[3] + height}`,
          )
        }
      }
    }
  }
  return keys
}

function rectangleSpatialCells(object: PdfNativeObject) {
  const left = Math.floor(object.box.x / REPEATED_RECTANGLE_SPATIAL_CELL_SIZE)
  const top = Math.floor(object.box.y / REPEATED_RECTANGLE_SPATIAL_CELL_SIZE)
  const right = Math.floor(
    (object.box.x + object.box.width) / REPEATED_RECTANGLE_SPATIAL_CELL_SIZE,
  )
  const bottom = Math.floor(
    (object.box.y + object.box.height) / REPEATED_RECTANGLE_SPATIAL_CELL_SIZE,
  )
  const cells: string[] = []
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) cells.push(`${x}:${y}`)
  }
  return cells
}

export function repeatedRectangleFallbackObjectIds(
  pages: PdfPageAnalysis[],
  evidence?: PdfRectangleIndexEvidence,
) {
  const assets = new Map(
    pages
      .flatMap((page) => page.assets ?? [])
      .map((asset) => [asset.id, asset] as const),
  )
  const rectangles = pages
    .flatMap((page) => page.objects ?? [])
    .filter(
      (
        object,
      ): object is PdfNativeObject & {
        kind: 'vector'
        assetId: string
      } =>
        object.kind === 'vector' &&
        Boolean(object.assetId) &&
        singleSolidRectangleFallbackAsset(assets.get(object.assetId!)),
    )
  const repeated = new Set<string>()
  const byAsset = new Map<string, typeof rectangles>()
  for (const object of rectangles) {
    const matches = byAsset.get(object.assetId) ?? []
    matches.push(object)
    byAsset.set(object.assetId, matches)
  }
  for (const matches of byAsset.values()) {
    if (matches.length < 2) continue
    for (const object of matches) repeated.add(object.id)
  }

  const geometryCells = new Map<string, typeof rectangles>()
  for (const object of rectangles) {
    const candidates = new Set(
      neighboringRectangleGeometryCells(object).flatMap(
        (key) => geometryCells.get(key) ?? [],
      ),
    )
    for (const candidate of candidates) {
      if (object.page === candidate.page) continue
      if (repeated.has(object.id) && repeated.has(candidate.id)) continue
      if (evidence) evidence.candidateComparisons += 1
      if (!sameRepeatedGeometry(object, candidate)) continue
      repeated.add(object.id)
      repeated.add(candidate.id)
    }
    const key = rectangleGeometryCell(object)
    const values = geometryCells.get(key) ?? []
    values.push(object)
    geometryCells.set(key, values)
  }

  const spatialCellsByPage = new Map<number, Map<string, typeof rectangles>>()
  for (const object of rectangles) {
    const cells =
      spatialCellsByPage.get(object.page) ??
      new Map<string, typeof rectangles>()
    spatialCellsByPage.set(object.page, cells)
    const objectCells = rectangleSpatialCells(object)
    const candidates = new Set(
      objectCells.flatMap((key) => cells.get(key) ?? []),
    )
    for (const candidate of candidates) {
      if (repeated.has(object.id) && repeated.has(candidate.id)) continue
      if (evidence) evidence.candidateComparisons += 1
      const smallerArea = Math.min(
        object.box.width * object.box.height,
        candidate.box.width * candidate.box.height,
      )
      if (
        smallerArea <= 0 ||
        intersectionArea(object.box, candidate.box) / smallerArea <
          MIN_REPEATED_RECTANGLE_OVERLAP
      ) {
        continue
      }
      repeated.add(object.id)
      repeated.add(candidate.id)
    }
    for (const key of objectCells) {
      const values = cells.get(key) ?? []
      values.push(object)
      cells.set(key, values)
    }
  }
  return repeated
}

export function decorativeNativeObjectIds(
  pages: PdfPageAnalysis[],
  repeatedRectangleObjectIds = repeatedRectangleFallbackObjectIds(pages),
) {
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
  for (const object of vectors) {
    if (
      isLargeVectorBox(object.box) &&
      repeatedRectangleObjectIds.has(object.id)
    ) {
      decorative.add(object.id)
    }
  }
  return decorative
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

function coextensiveNativeLayerPair(left: PdfPageRegion, right: PdfPageRegion) {
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

function coextensiveNativeLayerCluster(group: PdfPageRegion[]) {
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

function coextensiveNativeLayers(group: PdfPageRegion[]) {
  return coextensiveNativeLayerCluster(group) !== null
}

function provesCaptionBoundedNativeScaffold(
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

function adjacentPanelLabelOverlays(
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

function probablePanelLabelOverlayRegion(region: PdfPageRegion) {
  return (
    region.includedInReadingOrder &&
    region.nativeObjectIds.length === 0 &&
    region.lines.length > 0 &&
    ['body', 'spanning'].includes(region.kind) &&
    /^\s*\([a-z0-9ivxlcdm]+\)\s+\p{L}/iu.test(region.text)
  )
}

function denseGridNeighborRegions(regions: PdfPageRegion[]) {
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

async function captionBoundedSemanticEnvelopeCandidates(
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

const FIGURE_CONNECTIVITY_CELL_SIZE = 0.08
const FIGURE_CONNECTIVITY_GAP = 0.04

function figureConnectivityCells(box: NormalizedSourceBox, expansion = 0) {
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

function figureRegionSpatialIndex(regions: readonly PdfPageRegion[]) {
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

function mutableFigureRegionSpatialIndex(regions: readonly PdfPageRegion[]) {
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

type PdfFigureGroupingEvidence = {
  figureRegionCount: number
  retainedFigureRegionCount: number
  connectivityComparisons: number
  groupCount: number
}

async function connectedFigureRegionGroups({
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

function exactSourceLinesById(
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

function availableRegionsForTable(
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

function verticalBoxOverlap(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  return Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  )
}

function materiallyOverlappingSourceBoxes(
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

function sourceBoxesIntersect(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  return (
    left.page === right.page &&
    left.rotation === right.rotation &&
    horizontalBoxOverlap(left, right) > 0 &&
    verticalBoxOverlap(left, right) > 0
  )
}

function textPaintInventoryRunIdentity(
  run: PdfPageRegion['lines'][number]['runs'][number],
) {
  return JSON.stringify({
    page: run.page,
    sourceSequenceIndex: run.sourceSequenceIndex ?? null,
    text: run.text,
    sourceSemanticAdmission: run.sourceSemanticAdmission ?? null,
    // Flow analysis and DISPLAY inventory derive their boxes independently.
    // Bind ownership to the exact source item and complete paint provenance;
    // the DISPLAY inventory's own box remains authoritative for crop masking.
    sourceTextPaint: run.sourceTextPaint
      ? {
          algorithm: run.sourceTextPaint.algorithm,
          textLedgerSha256: run.sourceTextPaint.textLedgerSha256,
          normalizedTextStart: run.sourceTextPaint.normalizedTextStart,
          normalizedTextEnd: run.sourceTextPaint.normalizedTextEnd,
          operatorLedgerSha256: run.sourceTextPaint.operatorLedgerSha256,
          operationIndexes: [...run.sourceTextPaint.operationIndexes],
          filterableOperationIndexes: [
            ...run.sourceTextPaint.filterableOperationIndexes,
          ],
        }
      : null,
  })
}

function sourceTextPaintInventoryForPage(
  page: PdfPageAnalysis,
  regions: readonly PdfPageRegion[],
) {
  return (
    page.renderVisibleTextRuns ??
    regions.flatMap((region) =>
      region.page === page.page
        ? region.lines.flatMap((line) => line.runs)
        : [],
    )
  )
}

function ownedEquationTextPaintInventoryKeys(
  sourceLineIds: ReadonlySet<string>,
  regions: readonly PdfPageRegion[],
) {
  return new Set(
    regions.flatMap((region) =>
      region.lines.flatMap((line) =>
        sourceLineIds.has(line.id)
          ? line.runs.map(textPaintInventoryRunIdentity)
          : [],
      ),
    ),
  )
}

function unownedEquationSourceTextBoxes(
  sourceLineIds: ReadonlySet<string>,
  regions: readonly PdfPageRegion[],
  page: number,
  renderVisibleTextRuns: readonly PdfSourceRun[],
  renderOnlyOwnedRunKeys: ReadonlySet<string> = new Set(),
) {
  const ownedRunKeys = ownedEquationTextPaintInventoryKeys(
    sourceLineIds,
    regions,
  )
  const inventoryBoxes = renderVisibleTextRuns.flatMap((run) =>
    run.page === page &&
    run.text.trim().length > 0 &&
    !renderOnlyOwnedRunKeys.has(equationRenderOnlySourceRunIdentity(run)) &&
    !ownedRunKeys.has(textPaintInventoryRunIdentity(run))
      ? [
          {
            page: run.page,
            x: run.x,
            y: run.y,
            width: run.width,
            height: run.height,
            rotation: run.rotation,
            method: run.method,
          },
        ]
      : [],
  )
  const runlessLineBoxes = regions.flatMap((region) =>
    region.page !== page
      ? []
      : region.lines.flatMap((line) =>
          !sourceLineIds.has(line.id) &&
          line.text.trim().length > 0 &&
          line.runs.length === 0
            ? [{ ...line.box }]
            : [],
        ),
  )
  return [...inventoryBoxes, ...runlessLineBoxes]
}

function sourceTextOperationFilterPlanForEquationCrop(
  sourceCropBox: NormalizedSourceBox,
  sourceLineIds: ReadonlySet<string>,
  regions: readonly PdfPageRegion[],
  renderVisibleTextRuns: readonly PdfSourceRun[],
  renderOnlyOwnedRunKeys: ReadonlySet<string> = new Set(),
): PdfTextOperationFilterPlan | null {
  if (
    regions.some(
      (region) =>
        region.page === sourceCropBox.page &&
        region.lines.some(
          (line) =>
            !sourceLineIds.has(line.id) &&
            line.text.trim().length > 0 &&
            line.runs.length === 0 &&
            sourceBoxesIntersect(sourceCropBox, line.box),
        ),
    )
  ) {
    return null
  }
  const sourceOwnedRuns = regions.flatMap((region) =>
    region.page !== sourceCropBox.page
      ? []
      : region.lines.flatMap((line) =>
          !sourceLineIds.has(line.id)
            ? []
            : line.runs.filter(
                (run) =>
                  run.text.trim() && sourceBoxesIntersect(sourceCropBox, run),
              ),
        ),
  )
  const inventoryByIdentity = new Map(
    renderVisibleTextRuns.map((run) => [
      textPaintInventoryRunIdentity(run),
      run,
    ]),
  )
  const ownedRuns = sourceOwnedRuns.flatMap((run) => {
    const inventoryRun = inventoryByIdentity.get(
      textPaintInventoryRunIdentity(run),
    )
    return inventoryRun ? [inventoryRun] : []
  })
  const ownedRunKeys = new Set(ownedRuns.map(textPaintInventoryRunIdentity))
  const excludedRuns = renderVisibleTextRuns.filter(
    (run) =>
      run.page === sourceCropBox.page &&
      run.text.trim().length > 0 &&
      sourceBoxesIntersect(sourceCropBox, run) &&
      !renderOnlyOwnedRunKeys.has(equationRenderOnlySourceRunIdentity(run)) &&
      !ownedRunKeys.has(textPaintInventoryRunIdentity(run)),
  )
  if (
    sourceOwnedRuns.length === 0 ||
    sourceOwnedRuns.length > MAX_EQUATION_TEXT_LEDGER_SPANS ||
    ownedRuns.length !== sourceOwnedRuns.length ||
    excludedRuns.length === 0 ||
    excludedRuns.length > MAX_EQUATION_TEXT_LEDGER_SPANS ||
    [...ownedRuns, ...excludedRuns].some((run) => !run.sourceTextPaint)
  ) {
    return null
  }
  const provedExcludedRuns = excludedRuns
  const textLedgerIds = new Set(
    [...ownedRuns, ...provedExcludedRuns].map(
      (run) => run.sourceTextPaint!.textLedgerSha256,
    ),
  )
  const spanForRun = (run: (typeof ownedRuns)[number]) => ({
    start: run.sourceTextPaint!.normalizedTextStart,
    end: run.sourceTextPaint!.normalizedTextEnd,
  })
  const spanOrder = (
    left: ReturnType<typeof spanForRun>,
    right: ReturnType<typeof spanForRun>,
  ) => left.start - right.start || left.end - right.end
  const ownedTextLedgerSpans = ownedRuns.map(spanForRun).sort(spanOrder)
  const excludedTextLedgerSpans = provedExcludedRuns
    .map(spanForRun)
    .sort(spanOrder)
  if (
    textLedgerIds.size !== 1 ||
    [...ownedTextLedgerSpans, ...excludedTextLedgerSpans].some(
      ({ start, end }) =>
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end <= start,
    ) ||
    excludedTextLedgerSpans.some((excluded) =>
      ownedTextLedgerSpans.some(
        (owned) =>
          Math.min(excluded.end, owned.end) >
          Math.max(excluded.start, owned.start),
      ),
    )
  ) {
    return null
  }
  const sourceBoxForRun = (
    run: (typeof ownedRuns)[number],
  ): NormalizedSourceBox => ({
    page: run.page,
    x: run.x,
    y: run.y,
    width: run.width,
    height: run.height,
    rotation: run.rotation,
    method: run.method,
  })
  const ownedSourceBoxes = ownedRuns.map(sourceBoxForRun)
  const excludedSourceBoxes = provedExcludedRuns.map(sourceBoxForRun)
  const distinctSourceBoxCount = (boxes: readonly NormalizedSourceBox[]) =>
    new Set(
      boxes.map((box) =>
        [
          box.page,
          box.x,
          box.y,
          box.width,
          box.height,
          box.rotation,
          box.method,
        ].join('\u001f'),
      ),
    ).size
  if (
    distinctSourceBoxCount(ownedSourceBoxes) >
      MAX_EQUATION_OWNED_SOURCE_BOXES ||
    distinctSourceBoxCount(excludedSourceBoxes) >
      MAX_EQUATION_EXCLUDED_SOURCE_BOXES
  ) {
    return null
  }
  return {
    algorithm: 'pdfjs-display-text-operation-filter-v2',
    expansionPixels: 0,
    displayOperatorAdapter: PDFJS_DISPLAY_OPERATOR_ADAPTER,
    renderIntent: 'display',
    annotationMode: 'enable',
    sourceTextLedgerSha256: [...textLedgerIds][0],
    ownedTextLedgerSpans,
    excludedTextLedgerSpans,
    ownedSourceBoxes,
    excludedSourceBoxes,
  }
}

function hasOverlappingUnownedEquationText(
  ownedSourceBoxes: readonly NormalizedSourceBox[],
  sourceLineIds: ReadonlySet<string>,
  regions: PdfPageRegion[],
  renderVisibleTextRuns: readonly PdfSourceRun[],
  renderOnlyOwnedRunKeys: ReadonlySet<string> = new Set(),
) {
  if (ownedSourceBoxes.length === 0) return false
  const sourcePage = ownedSourceBoxes[0].page
  return unownedEquationSourceTextBoxes(
    sourceLineIds,
    regions,
    sourcePage,
    renderVisibleTextRuns,
    renderOnlyOwnedRunKeys,
  ).some((unowned) =>
    ownedSourceBoxes.some((owned) =>
      materiallyOverlappingSourceBoxes(owned, unowned),
    ),
  )
}

function unownedSourceTextBoxesInEquationCrop(
  sourceCropBox: NormalizedSourceBox,
  sourceLineIds: ReadonlySet<string>,
  regions: PdfPageRegion[],
  renderVisibleTextRuns: readonly PdfSourceRun[],
  renderOnlyOwnedRunKeys: ReadonlySet<string> = new Set(),
) {
  return unownedEquationSourceTextBoxes(
    sourceLineIds,
    regions,
    sourceCropBox.page,
    renderVisibleTextRuns,
    renderOnlyOwnedRunKeys,
  ).filter((unowned) => sourceBoxesIntersect(sourceCropBox, unowned))
}

function excludedEquationSourceBoxesForCrop(
  sourceCropBox: NormalizedSourceBox,
  ownedSourceBoxes: readonly NormalizedSourceBox[],
  sourceLineIds: ReadonlySet<string>,
  regions: readonly PdfPageRegion[],
  pageWidth: number,
  pageHeight: number,
) {
  if (ownedSourceBoxes.length === 0) return []
  const ownedUnion = {
    page: sourceCropBox.page,
    x: Math.min(...ownedSourceBoxes.map((box) => box.x)),
    y: Math.min(...ownedSourceBoxes.map((box) => box.y)),
    width:
      Math.max(...ownedSourceBoxes.map((box) => box.x + box.width)) -
      Math.min(...ownedSourceBoxes.map((box) => box.x)),
    height:
      Math.max(...ownedSourceBoxes.map((box) => box.y + box.height)) -
      Math.min(...ownedSourceBoxes.map((box) => box.y)),
    rotation: sourceCropBox.rotation,
    method: 'pdf-text' as const,
  }
  const inlineFormulaBaseIds = new Set(
    [...sourceLineIds].flatMap((lineId) => {
      const match = /^(.*-inline-stacked-\d+)-formula$/u.exec(lineId)
      return match ? [match[1]] : []
    }),
  )
  const sourceRegionIds = new Set(
    regions
      .filter((region) =>
        region.lines.some((line) => sourceLineIds.has(line.id)),
      )
      .map((region) => region.id),
  )
  const sourceColumns = new Set(
    regions
      .filter((region) =>
        region.lines.some((line) => sourceLineIds.has(line.id)),
      )
      .map((region) => region.column),
  )
  const tolerance = 0.00001
  const maximumHorizontalGap =
    EQUATION_EXCLUDED_TEXT_MASK_PIXELS /
      (Math.max(1, pageWidth) * EQUATION_EXCLUDED_TEXT_MAX_RENDER_SCALE) +
    tolerance
  const maximumVerticalGap =
    EQUATION_EXCLUDED_TEXT_MASK_PIXELS /
      (Math.max(1, pageHeight) * EQUATION_EXCLUDED_TEXT_MAX_RENDER_SCALE) +
    tolerance
  const trustedLine = (
    region: PdfPageRegion,
    line: PdfPageRegion['lines'][number],
  ) => {
    if (region.kind !== 'body' && region.kind !== 'spanning') return false
    const inlineSibling = /^(.*-inline-stacked-\d+)-(before|after)$/u.exec(
      line.id,
    )
    if (inlineSibling && inlineFormulaBaseIds.has(inlineSibling[1])) {
      return true
    }
    if (sourceRegionIds.has(region.id)) return true
    const lexicalWords = line.text.match(/\p{L}{2,}/gu) ?? []
    return (
      lexicalWords.length >= 2 &&
      (region.column === 'span' ||
        sourceColumns.has('span') ||
        sourceColumns.has(region.column))
    )
  }
  const directionFor = (box: NormalizedSourceBox) => {
    const aboveGap = ownedUnion.y - (box.y + box.height)
    if (aboveGap >= -tolerance && aboveGap <= maximumVerticalGap) {
      return 'top'
    }
    const belowGap = box.y - (ownedUnion.y + ownedUnion.height)
    if (belowGap >= -tolerance && belowGap <= maximumVerticalGap) {
      return 'bottom'
    }
    return null
  }
  const explicitInlineDirectionFor = (box: NormalizedSourceBox) => {
    const leftGap = ownedUnion.x - (box.x + box.width)
    if (leftGap >= -tolerance && leftGap <= maximumHorizontalGap) {
      return 'left'
    }
    const rightGap = box.x - (ownedUnion.x + ownedUnion.width)
    if (rightGap >= -tolerance && rightGap <= maximumHorizontalGap) {
      return 'right'
    }
    return null
  }
  const nearCropEdge = (
    box: NormalizedSourceBox,
    direction: 'top' | 'bottom' | 'left' | 'right',
  ) => {
    if (direction === 'top') {
      return box.y + box.height >= sourceCropBox.y - maximumVerticalGap
    }
    if (direction === 'bottom') {
      return (
        box.y <= sourceCropBox.y + sourceCropBox.height + maximumVerticalGap
      )
    }
    if (direction === 'left') {
      return box.x + box.width >= sourceCropBox.x - maximumHorizontalGap
    }
    return box.x <= sourceCropBox.x + sourceCropBox.width + maximumHorizontalGap
  }
  const excluded = regions.flatMap((region) =>
    region.page !== sourceCropBox.page
      ? []
      : region.lines.flatMap((line) => {
          if (sourceLineIds.has(line.id) || !trustedLine(region, line)) {
            return []
          }
          const inlineSibling =
            /^(.*-inline-stacked-\d+)-(before|after)$/u.exec(line.id)
          return line.runs.flatMap((run) => {
            if (!run.text.trim()) return []
            const box: NormalizedSourceBox = {
              page: run.page,
              x: run.x,
              y: run.y,
              width: run.width,
              height: run.height,
              rotation: run.rotation,
              method: run.method,
            }
            const direction =
              directionFor(box) ??
              (inlineSibling && inlineFormulaBaseIds.has(inlineSibling[1])
                ? explicitInlineDirectionFor(box)
                : null)
            if (
              !direction ||
              !nearCropEdge(box, direction) ||
              ((direction === 'top' || direction === 'bottom') &&
                horizontalBoxOverlap(sourceCropBox, box) <= 0) ||
              ((direction === 'left' || direction === 'right') &&
                verticalBoxOverlap(sourceCropBox, box) <= 0)
            ) {
              return []
            }
            return [box]
          })
        }),
  )
  const canonical = [
    ...new Map(
      excluded.map(
        (box) =>
          [
            [
              box.page,
              rounded(box.x),
              rounded(box.y),
              rounded(box.width),
              rounded(box.height),
              box.rotation,
              box.method,
            ].join('\u001f'),
            {
              ...box,
              x: rounded(box.x),
              y: rounded(box.y),
              width: rounded(box.width),
              height: rounded(box.height),
            },
          ] as const,
      ),
    ).values(),
  ].sort(
    (left, right) =>
      [
        left.page - right.page,
        left.y - right.y,
        left.x - right.x,
        left.height - right.height,
        left.width - right.width,
        left.rotation - right.rotation,
        left.method.localeCompare(right.method),
      ].find((difference) => difference !== 0) ?? 0,
  )
  return canonical.length <= MAX_EQUATION_EXCLUDED_SOURCE_BOXES ? canonical : []
}

function paddedEquationCropBox(
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

function tableSourceCropRetryPaddings(sourceBox: NormalizedSourceBox) {
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

function neighborBoundedCropBoxes(
  sourceBox: NormalizedSourceBox,
  sourceLineIds: ReadonlySet<string>,
  regions: PdfPageRegion[],
  desiredPadding: number,
  neighborGapFraction = 0.25,
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
  const left = bounds.left ?? desired.left
  const top = bounds.top ?? desired.top
  const right = bounds.right ?? desired.right
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

type BoundedAlgorithmBlock = {
  caption: PdfPageRegion
  label: string
  sourceRegions: PdfPageRegion[]
  sourceLineIds: string[]
  sourceText: string
  sourceBox: NormalizedSourceBox
}

function parsedAlgorithmCaption(region: PdfPageRegion) {
  const normalized = region.text.replace(/\s+/gu, ' ').trim()
  const match =
    /^Algorithm\s+((?:\d+(?:\.\d+)*[A-Za-z]?|[IVXLCDM]+))(?=$|[\s:.)-])(?:\s*[:.)-]?\s*)(.*)$/iu.exec(
      normalized,
    )
  if (!match) return null
  return {
    label: `Algorithm ${match[1]}`,
    title: match[2].trim(),
  }
}

function algorithmLineMarkers(value: string) {
  return [...value.matchAll(/(?:^|\s)(\d{1,3})\s*[:.]/gu)].map((match) =>
    Number(match[1]),
  )
}

function algorithmTerminalLine(value: string) {
  return (
    /\breturn\b/iu.test(value) ||
    /\boutput\s*:/iu.test(value) ||
    /\bend\s+(?:algorithm|procedure|while|for|if|loop|function)\b/iu.test(value)
  )
}

function recoveredAlgorithmSourceText(regions: PdfPageRegion[]) {
  return regions
    .flatMap((region) =>
      region.lines.length > 0
        ? region.lines.map((line) => line.text.trim()).filter(Boolean)
        : [region.text.trim()].filter(Boolean),
    )
    .join('\n')
}

function boundedAlgorithmBlocks(
  regions: PdfPageRegion[],
  consumedRegionIds: ReadonlySet<string>,
) {
  const claimedRegionIds = new Set<string>()
  const blocks: BoundedAlgorithmBlock[] = []
  const captions = regions
    .filter(
      (region) =>
        !consumedRegionIds.has(region.id) &&
        region.lines.length > 0 &&
        parsedAlgorithmCaption(region) !== null,
    )
    .sort(
      (left, right) =>
        left.page - right.page ||
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.id.localeCompare(right.id),
    )
  for (const caption of captions) {
    if (claimedRegionIds.has(caption.id)) continue
    const parsed = parsedAlgorithmCaption(caption)!
    const candidates = regions
      .filter(
        (region) =>
          region.id !== caption.id &&
          !claimedRegionIds.has(region.id) &&
          !consumedRegionIds.has(region.id) &&
          region.page === caption.page &&
          region.lines.length > 0 &&
          region.text.trim().length > 0 &&
          region.kind !== 'caption' &&
          region.box.y >= caption.box.y + caption.box.height - 0.006 &&
          region.box.y <= caption.box.y + 0.65 &&
          horizontalOverlapRatio(region.box, caption.box) >= 0.7,
      )
      .sort(
        (left, right) =>
          left.box.y - right.box.y ||
          left.box.x - right.box.x ||
          left.id.localeCompare(right.id),
      )
    const requireIndex = candidates.findIndex((region) =>
      /^(?:\d{1,3}\s*[:.]\s*)?(?:Require|Input)\s*:/iu.test(region.text.trim()),
    )
    if (requireIndex < 0) continue
    const sourceRegions: PdfPageRegion[] = []
    let expectedMarker = 1
    let previousBottom = caption.box.y + caption.box.height
    let terminal = false
    const anchoredCandidates = candidates.slice(requireIndex)
    for (const [candidateIndex, region] of anchoredCandidates.entries()) {
      const gap = region.box.y - previousBottom
      if (gap > 0.06) break
      const markers = algorithmLineMarkers(region.text)
      if (
        markers.some((marker) => {
          if (marker !== expectedMarker) return true
          expectedMarker += 1
          return false
        })
      ) {
        sourceRegions.length = 0
        break
      }
      sourceRegions.push(region)
      previousBottom = Math.max(
        previousBottom,
        region.box.y + region.box.height,
      )
      const nextRegion = anchoredCandidates[candidateIndex + 1]
      const nextMarkers = nextRegion
        ? algorithmLineMarkers(nextRegion.text)
        : []
      const nextContinuesSequence = Boolean(
        nextRegion &&
        nextRegion.box.y - previousBottom <= 0.06 &&
        nextMarkers[0] === expectedMarker,
      )
      if (
        expectedMarker >= 4 &&
        algorithmTerminalLine(region.text) &&
        !nextContinuesSequence
      ) {
        terminal = true
        break
      }
    }
    if (
      !terminal ||
      expectedMarker < 4 ||
      sourceRegions.length === 0 ||
      sourceRegions[0] !== candidates[requireIndex]
    ) {
      continue
    }
    const sourceLineIds = sourceRegions.flatMap((region) =>
      region.lines.map((line) => line.id),
    )
    if (
      sourceLineIds.length === 0 ||
      new Set(sourceLineIds).size !== sourceLineIds.length
    ) {
      continue
    }
    const panelRegions = [caption, ...sourceRegions]
    blocks.push({
      caption,
      label: parsed.label,
      sourceRegions,
      sourceLineIds,
      sourceText: recoveredAlgorithmSourceText(sourceRegions),
      sourceBox: unionBox(panelRegions),
    })
    for (const region of panelRegions) claimedRegionIds.add(region.id)
  }
  return blocks
}

type PreformattedLineOwner = {
  region: PdfPageRegion
  line: PdfPageRegion['lines'][number]
  /**
   * Canonical source order is computed from the complete page geometry before
   * a listing is narrowed to its owning lines. Keeping that ordinal on the
   * owner means every later materializer (segments, provenance, and recovered
   * text) reuses the same total order instead of applying a context-free sort.
   */
  canonicalOrder?: number
}

type BoundedPreformattedSegment = {
  page: number
  sourceLines: PreformattedLineOwner[]
  sourceBox: NormalizedSourceBox
  sourceObjectIds: string[]
  sourceObjectBoxes: NormalizedSourceBox[]
}

type BoundedPreformattedBlock = {
  caption: PdfPageRegion
  label: string
  semanticKind: 'algorithm' | 'code'
  sourceLines: PreformattedLineOwner[]
  segments: BoundedPreformattedSegment[]
  preformatted: PdfPreformattedSource
  evidence: string[]
  captionFallbackLineId: string | null
}

const MONOSPACED_SOURCE_FONT =
  /(?:courier|inconsolata|nimbusmon|mono|typewriter|cmtt|lmtt|sftt)/iu

function normalizedLineageBox(
  source: NormalizedSourceBox,
): NormalizedSourceBox {
  return {
    page: source.page,
    x: source.x,
    y: source.y,
    width: source.width,
    height: source.height,
    rotation: source.rotation,
    method: source.method,
  }
}

function sourceLineOrder(
  left: PreformattedLineOwner,
  right: PreformattedLineOwner,
) {
  // Every production owner is canonicalized before it reaches a materializer.
  // Keep an uncanonicalized owner deterministic too, and make the mixed case
  // transitive by placing it after the page-wide rank instead of switching
  // between two incomparable relations.
  const leftRank = left.canonicalOrder ?? Number.MAX_SAFE_INTEGER
  const rightRank = right.canonicalOrder ?? Number.MAX_SAFE_INTEGER
  if (leftRank !== rightRank) {
    return leftRank - rightRank
  }
  // Owners created by a narrowly-scoped detector may not have the page-wide
  // ordinal. Their fallback still needs to be a strict total order. In
  // particular, never compare left/right by one rule and single/span by a
  // different rule: that relation is non-transitive when the lanes mix.
  const columnRank = (column: PdfRegionColumn) =>
    column === 'left' ? 0 : column === 'right' ? 1 : column === 'span' ? 2 : 3
  return (
    left.line.box.page - right.line.box.page ||
    columnRank(left.region.column) - columnRank(right.region.column) ||
    left.line.box.y - right.line.box.y ||
    left.line.box.x - right.line.box.x ||
    left.region.id.localeCompare(right.region.id) ||
    left.line.id.localeCompare(right.line.id)
  )
}

function sourceRegionOrder(left: PdfPageRegion, right: PdfPageRegion) {
  const columnRank = (column: PdfRegionColumn) =>
    column === 'left' ? 0 : column === 'right' ? 1 : column === 'span' ? 2 : 3
  return (
    left.box.y - right.box.y ||
    columnRank(left.column) - columnRank(right.column) ||
    left.box.x - right.box.x ||
    left.id.localeCompare(right.id)
  )
}

/**
 * Build the same page-spanning bands used by the canonical reading-order
 * resolver. A span is emitted after the left/right (or single) regions above
 * it and before the regions below it. The resulting ordinal is a strict total
 * order even when a page mixes left, right, single, and span regions.
 */
function canonicalSourceLineOwners(
  regions: PdfPageRegion[],
  includeBlankLines = false,
) {
  const eligibleRegions = regions.filter(
    (region) =>
      region.lines.length > 0 &&
      !['header', 'footer', 'page-number'].includes(region.kind),
  )
  const orderedOwners: PreformattedLineOwner[] = []
  const pages = [...new Set(eligibleRegions.map((region) => region.page))].sort(
    (left, right) => left - right,
  )
  for (const page of pages) {
    const pageRegions = eligibleRegions.filter((region) => region.page === page)
    const emitted = new Set<string>()
    const appendRegions = (pageSlice: PdfPageRegion[]) => {
      const columns: PdfRegionColumn[] = ['left', 'right', 'single']
      for (const column of columns) {
        pageSlice
          .filter((region) => region.column === column)
          .sort(sourceRegionOrder)
          .forEach((region) => {
            const lines = [...region.lines]
              .filter((line) => includeBlankLines || line.text.trim())
              .sort(
                (left, right) =>
                  left.box.y - right.box.y ||
                  left.box.x - right.box.x ||
                  left.id.localeCompare(right.id),
              )
            for (const line of lines) {
              orderedOwners.push({ region, line })
            }
            emitted.add(region.id)
          })
      }
      // A page without a detected column split can still contain a source
      // region tagged as span. Keep it deterministic after the ordinary flow.
      pageSlice
        .filter((region) => region.column === 'span')
        .sort(sourceRegionOrder)
        .forEach((region) => {
          const lines = [...region.lines]
            .filter((line) => includeBlankLines || line.text.trim())
            .sort(
              (left, right) =>
                left.box.y - right.box.y ||
                left.box.x - right.box.x ||
                left.id.localeCompare(right.id),
            )
          for (const line of lines) orderedOwners.push({ region, line })
          emitted.add(region.id)
        })
      // A malformed or future column value must not disappear from the order.
      pageSlice
        .filter((region) => !emitted.has(region.id))
        .sort((left, right) => {
          const rank = (column: PdfRegionColumn) =>
            column === 'left'
              ? 0
              : column === 'right'
                ? 1
                : column === 'span'
                  ? 2
                  : 3
          return (
            rank(left.column) - rank(right.column) ||
            sourceRegionOrder(left, right)
          )
        })
        .forEach((region) => {
          for (const line of [...region.lines]
            .filter((line) => includeBlankLines || line.text.trim())
            .sort(
              (left, right) =>
                left.box.y - right.box.y ||
                left.box.x - right.box.x ||
                left.id.localeCompare(right.id),
            )) {
            orderedOwners.push({ region, line })
          }
        })
    }

    const spans = pageRegions
      .filter((region) => region.column === 'span')
      .sort(sourceRegionOrder)
    for (const span of spans) {
      const band = pageRegions.filter(
        (region) =>
          region.column !== 'span' &&
          !emitted.has(region.id) &&
          region.box.y < span.box.y,
      )
      appendRegions(band)
      const spanLines = [...span.lines]
        .filter((line) => includeBlankLines || line.text.trim())
        .sort(
          (left, right) =>
            left.box.y - right.box.y ||
            left.box.x - right.box.x ||
            left.id.localeCompare(right.id),
        )
      for (const line of spanLines) orderedOwners.push({ region: span, line })
      emitted.add(span.id)
    }
    appendRegions(pageRegions.filter((region) => !emitted.has(region.id)))
  }
  return orderedOwners.map((owner, index) => ({
    ...owner,
    canonicalOrder: index,
  }))
}

function canonicalizeSourceLineOwners(
  regions: PdfPageRegion[],
  owners: PreformattedLineOwner[],
) {
  const orderByLineId = new Map(
    canonicalSourceLineOwners(regions, true).map((owner) => [
      owner.line.id,
      owner.canonicalOrder!,
    ]),
  )
  return owners.map((owner) => ({
    ...owner,
    canonicalOrder: orderByLineId.get(owner.line.id),
  }))
}

function orderedSourceLines(regions: PdfPageRegion[]) {
  return canonicalSourceLineOwners(regions)
}

function substantiveSourceRuns(line: PdfPageRegion['lines'][number]) {
  return line.runs.filter((run) => run.text.length > 0)
}

function monospacedSourceLine(line: PdfPageRegion['lines'][number]) {
  const runs = substantiveSourceRuns(line)
  return (
    runs.length > 0 &&
    runs.every((run) => MONOSPACED_SOURCE_FONT.test(run.fontName))
  )
}

function exactSingleRunSourceLine(line: PdfPageRegion['lines'][number]) {
  const runs = substantiveSourceRuns(line)
  return (
    runs.length === 1 &&
    runs[0].text === line.text &&
    !line.text.includes('\uFFFD')
  )
}

function exactOrderedMultiRunSourceLine(line: PdfPageRegion['lines'][number]) {
  const runs = substantiveSourceRuns(line)
  if (
    runs.length < 2 ||
    line.text.includes('\uFFFD') ||
    runs.some(
      (run) =>
        !run.text.trim() ||
        run.text.includes('\uFFFD') ||
        !Number.isSafeInteger(run.sourceSequenceIndex) ||
        run.sourceSequenceIndex! < 0 ||
        !Number.isSafeInteger(run.page) ||
        run.page < 1 ||
        !Number.isFinite(run.x) ||
        !Number.isFinite(run.y) ||
        !Number.isFinite(run.width) ||
        !Number.isFinite(run.height) ||
        run.width <= 0 ||
        run.height <= 0 ||
        run.page !== line.box.page ||
        run.rotation !== line.box.rotation,
    )
  ) {
    return false
  }
  const containmentTolerance = Math.max(0.00002, line.box.height * 0.05)
  const lineRight = line.box.x + line.box.width
  const lineBottom = line.box.y + line.box.height
  if (
    runs.some(
      (run) =>
        run.x < line.box.x - containmentTolerance ||
        run.y < line.box.y - containmentTolerance ||
        run.x + run.width > lineRight + containmentTolerance ||
        run.y + run.height > lineBottom + containmentTolerance,
    )
  ) {
    return false
  }
  const first = runs[0]
  for (let index = 1; index < runs.length; index += 1) {
    const previous = runs[index - 1]
    const run = runs[index]
    const baselineTolerance = Math.max(
      0.00002,
      Math.min(first.height, run.height) * 0.05,
    )
    const overlapTolerance = Math.max(
      0.00002,
      Math.min(previous.height, run.height) * 0.025,
    )
    const horizontalGap = run.x - (previous.x + previous.width)
    if (
      run.sourceSequenceIndex! <= previous.sourceSequenceIndex! ||
      run.x < previous.x ||
      Math.abs(run.y - first.y) > baselineTolerance ||
      horizontalGap < -overlapTolerance ||
      horizontalGap > Math.max(0.03, line.box.height * 3)
    ) {
      return false
    }
  }
  return mergePdfRunText(runs) === line.text
}

type ExactPreformattedLineProof =
  'exact-single-run-line-text' | 'exact-ordered-multi-run-line-text'

function exactPreformattedLineProof(
  line: PdfPageRegion['lines'][number],
): ExactPreformattedLineProof | null {
  if (exactSingleRunSourceLine(line)) return 'exact-single-run-line-text'
  if (exactOrderedMultiRunSourceLine(line)) {
    return 'exact-ordered-multi-run-line-text'
  }
  return null
}

function sourceLineRecord(
  { region, line }: PreformattedLineOwner,
  indentColumns = 0,
): PdfPreformattedSourceLine {
  return {
    text: line.text.replace(/\s+$/u, ''),
    indentColumns,
    sourceRegionId: region.id,
    sourceLineId: line.id,
    sourceBox: normalizedLineageBox(line.box),
    sourceRunBoxes: substantiveSourceRuns(line).map((run) =>
      normalizedLineageBox(run),
    ),
  }
}

function hasLiteralLeadingWhitespace(value: string) {
  return /^[\t ]/u.test(value)
}

function attachedPreformattedLabel(value: string) {
  return /^(?:Algorithm|Listing)\s+(?:\d+(?:\.\d+)*[A-Za-z]?|[IVXLCDM]+)(?=$|[\s:.)–—-])/iu.test(
    value.trim(),
  )
}

function contiguousPreformattedFlow(
  previous: PreformattedLineOwner,
  next: PreformattedLineOwner,
) {
  const sameLane =
    previous.region.column === next.region.column ||
    (['single', 'span'].includes(previous.region.column) &&
      ['single', 'span'].includes(next.region.column))
  if (previous.line.box.page === next.line.box.page && sameLane) {
    const gap =
      next.line.box.y - (previous.line.box.y + previous.line.box.height)
    return gap >= -0.006 && gap <= Math.max(0.03, previous.line.box.height * 2)
  }
  const columnBreak =
    previous.line.box.page === next.line.box.page &&
    previous.region.column === 'left' &&
    next.region.column === 'right'
  const crossPageColumnBreak =
    next.line.box.page === previous.line.box.page + 1 &&
    previous.region.column === 'right' &&
    next.region.column === 'left'
  const pageBreak =
    (next.line.box.page === previous.line.box.page + 1 && sameLane) ||
    crossPageColumnBreak
  return (
    (columnBreak || pageBreak) &&
    previous.line.box.y >= 0.55 &&
    next.line.box.y <= 0.25
  )
}

function sourceIndentationListingEvidence(lines: PreformattedLineOwner[]) {
  if (lines.length < 4) return false
  const ordered = [...lines].sort(sourceLineOrder)
  const levels: number[] = []
  for (const { line } of ordered) {
    const tolerance = Math.max(0.003, line.box.height * 0.35)
    if (!levels.some((level) => Math.abs(level - line.box.x) <= tolerance)) {
      levels.push(line.box.x)
    }
  }
  levels.sort((left, right) => left - right)
  if (levels.length < 3) return false

  const rightEdges = ordered.map(({ line }) => line.box.x + line.box.width)
  const raggedRange = Math.max(...rightEdges) - Math.min(...rightEdges)
  const orderedHeights = ordered
    .map(({ line }) => line.box.height)
    .sort((left, right) => left - right)
  const medianHeight = orderedHeights[Math.floor(orderedHeights.length / 2)]
  return raggedRange >= Math.max(0.025, medianHeight * 1.5)
}

type UnresolvedPreformattedDetection = {
  page: number
  regionIds: string[]
  sourceBoxes: NormalizedSourceBox[]
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

function sourceEvidencePreformattedBlocks(
  regions: PdfPageRegion[],
  claimedLineIds: Set<string>,
  claimedCaptionRegionIds: Set<string>,
) {
  const ordered = orderedSourceLines(regions)
  const blocks: BoundedPreformattedBlock[] = []
  const unresolved: UnresolvedPreformattedDetection[] = []

  const attachedCaption = (
    sourceLines: PreformattedLineOwner[],
    firstIndex: number,
    lastIndex: number,
  ) => {
    const first = sourceLines[0]
    const last = sourceLines.at(-1)!
    const candidates = [ordered[firstIndex - 1], ordered[lastIndex + 1]].filter(
      (
        candidate,
      ): candidate is PreformattedLineOwner & {
        canonicalOrder: number
      } => {
        if (!candidate || sourceLines.includes(candidate)) return false
        if (claimedCaptionRegionIds.has(candidate.region.id)) return false
        const before = candidate === ordered[firstIndex - 1]
        const gap = before
          ? first.line.box.y -
            (candidate.line.box.y + candidate.line.box.height)
          : candidate.line.box.y - (last.line.box.y + last.line.box.height)
        const samePage =
          candidate.line.box.page ===
          (before ? first.line.box.page : last.line.box.page)
        if (!samePage || gap < -0.006 || gap > 0.08) return false
        return (
          attachedPreformattedLabel(candidate.line.text) ||
          (before && /:\s*$/u.test(candidate.line.text.trim()))
        )
      },
    )
    const regionIds = new Set(candidates.map(({ region }) => region.id))
    return regionIds.size === 1 ? candidates[0] : null
  }

  const accept = (
    sourceLines: PreformattedLineOwner[],
    firstIndex: number,
    lastIndex: number,
    evidence: string,
  ) => {
    if (
      sourceLines.length < 3 ||
      sourceLines.some(({ line }) => claimedLineIds.has(line.id))
    ) {
      return
    }
    const caption = attachedCaption(sourceLines, firstIndex, lastIndex)
    if (!caption) {
      unresolved.push({
        page: sourceLines[0].line.box.page,
        regionIds: [...new Set(sourceLines.map(({ region }) => region.id))],
        sourceBoxes: sourceLines.map(({ line }) =>
          normalizedLineageBox(line.box),
        ),
      })
      return
    }
    const preformatted = exactPreformattedSource(sourceLines, true)
    blocks.push({
      caption: caption.region,
      label: attachedPreformattedLabel(caption.line.text)
        ? caption.line.text
            .trim()
            .match(
              /^(?:Algorithm|Listing)\s+(?:\d+(?:\.\d+)*[A-Za-z]?|[IVXLCDM]+)/iu,
            )![0]
        : `Code block p${String(sourceLines[0].line.box.page).padStart(3, '0')}-${String(
            blocks.filter(
              (block) => block.caption.page === sourceLines[0].line.box.page,
            ).length + 1,
          ).padStart(3, '0')}`,
      semanticKind: /^Algorithm\b/iu.test(caption.line.text.trim())
        ? 'algorithm'
        : 'code',
      sourceLines,
      segments: preformattedSegments(sourceLines),
      preformatted,
      evidence: [
        'source-preformatted-block',
        evidence,
        'source-region-lane-continuity',
        ...preformatted.evidence,
      ],
      captionFallbackLineId: null,
    })
    claimedCaptionRegionIds.add(caption.region.id)
    for (const { line } of sourceLines) claimedLineIds.add(line.id)
  }

  for (let index = 0; index < ordered.length; index += 1) {
    if (claimedLineIds.has(ordered[index].line.id)) continue
    if (monospacedSourceLine(ordered[index].line)) {
      const sourceLines = [ordered[index]]
      let lastIndex = index
      while (
        lastIndex + 1 < ordered.length &&
        !claimedLineIds.has(ordered[lastIndex + 1].line.id) &&
        monospacedSourceLine(ordered[lastIndex + 1].line) &&
        contiguousPreformattedFlow(ordered[lastIndex], ordered[lastIndex + 1])
      ) {
        sourceLines.push(ordered[++lastIndex])
      }
      if (sourceLines.length >= 3) {
        accept(sourceLines, index, lastIndex, 'monospaced-source-lines')
        index = lastIndex
        continue
      }
    }

    const anchor = ordered[index]
    if (
      monospacedSourceLine(anchor.line) ||
      (!attachedPreformattedLabel(anchor.line.text) &&
        !/:\s*$/u.test(anchor.line.text.trim()))
    ) {
      continue
    }
    const sourceLines: PreformattedLineOwner[] = []
    let lastIndex = index
    while (
      lastIndex + 1 < ordered.length &&
      !claimedLineIds.has(ordered[lastIndex + 1].line.id) &&
      (lastIndex === index
        ? ordered[lastIndex].line.box.page ===
            ordered[lastIndex + 1].line.box.page &&
          ordered[lastIndex + 1].line.box.y -
            (ordered[lastIndex].line.box.y +
              ordered[lastIndex].line.box.height) >=
            -0.006 &&
          ordered[lastIndex + 1].line.box.y -
            (ordered[lastIndex].line.box.y +
              ordered[lastIndex].line.box.height) <=
            0.08
        : contiguousPreformattedFlow(
            ordered[lastIndex],
            ordered[lastIndex + 1],
          ))
    ) {
      sourceLines.push(ordered[++lastIndex])
    }
    if (sourceIndentationListingEvidence(sourceLines)) {
      accept(
        sourceLines,
        index + 1,
        lastIndex,
        'source-indentation-and-ragged-measure',
      )
      index = lastIndex
    }
  }
  return { blocks, unresolved }
}

function exactPreformattedSource(
  lines: PreformattedLineOwner[],
  allowTranscriptProof: boolean,
): PdfPreformattedSource {
  const ordered = [...lines].sort(sourceLineOrder)
  const lineProofs = ordered.map(({ line }) => exactPreformattedLineProof(line))
  const laneKey = ({ region, line }: PreformattedLineOwner) =>
    `${line.box.page}:${region.column}`
  const laneBaselines = new Map<string, number>()
  for (const owner of ordered) {
    const key = laneKey(owner)
    laneBaselines.set(
      key,
      Math.min(laneBaselines.get(key) ?? owner.line.box.x, owner.line.box.x),
    )
  }
  const relativeIndent = (owner: PreformattedLineOwner) =>
    owner.line.box.x - laneBaselines.get(laneKey(owner))!
  const stablePageIndent = ordered.every(
    (owner) => Math.abs(relativeIndent(owner)) <= 0.002,
  )
  const hasLiteralIndentation = ordered.some(({ line }) =>
    hasLiteralLeadingWhitespace(line.text),
  )
  const proved =
    allowTranscriptProof &&
    ordered.length > 0 &&
    lineProofs.every((proof) => proof !== null)
  const indentationLevels: number[] = []
  for (const owner of ordered) {
    const indent = relativeIndent(owner)
    const tolerance = Math.max(owner.line.box.height * 0.75, 0.006)
    if (
      !indentationLevels.some((level) => Math.abs(level - indent) <= tolerance)
    ) {
      indentationLevels.push(indent)
      indentationLevels.sort((left, right) => left - right)
    }
  }
  const recordedLines = ordered.map((owner) => {
    const indent = relativeIndent(owner)
    const level = indentationLevels.reduce(
      (best, candidate, index) =>
        Math.abs(candidate - indent) <
        Math.abs(indentationLevels[best] - indent)
          ? index
          : best,
      0,
    )
    // A source line may already carry literal indentation. In that case the
    // text itself is the lossless representation; adding a quantized geometry
    // class would double the visual indent. Geometry supplies indentation only
    // when extraction discarded the leading whitespace.
    const indentColumns =
      hasLiteralIndentation || stablePageIndent
        ? 0
        : Math.min(16, Math.max(0, level * 2))
    return sourceLineRecord(owner, indentColumns)
  })
  return {
    status: proved ? 'proved' : 'unresolved',
    lines: allowTranscriptProof ? recordedLines : [],
    evidence: proved
      ? [
          'deterministic-source-line-order',
          lineProofs.includes('exact-ordered-multi-run-line-text')
            ? 'exact-ordered-multi-run-line-text'
            : 'exact-single-run-line-text',
          'source-line-breaks-preserved',
          stablePageIndent
            ? 'zero-derived-indentation'
            : 'source-geometry-indentation',
        ]
      : [
          'deterministic-source-line-order',
          'source-text-exactness-unresolved',
          ...(allowTranscriptProof
            ? ['unresolved-source-lines-retained-for-review']
            : []),
        ],
  }
}

function preformattedSegments(
  sourceLines: PreformattedLineOwner[],
  sourceObjects: PdfNativeObject[] = [],
) {
  const lanes = [
    ...new Map(
      sourceLines.map((owner) => [
        `${owner.line.box.page}:${owner.region.column}`,
        { page: owner.line.box.page, column: owner.region.column },
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.page - right.page ||
      (left.column === 'left' ? 0 : left.column === 'right' ? 1 : -1) -
        (right.column === 'left' ? 0 : right.column === 'right' ? 1 : -1),
  )
  return lanes.map<BoundedPreformattedSegment>(({ page, column }) => {
    const pageLines = sourceLines
      .filter(
        ({ region, line }) =>
          line.box.page === page && region.column === column,
      )
      .sort(sourceLineOrder)
    const pageObjects = sourceObjects
      .filter((object) => object.page === page)
      .sort(
        (left, right) =>
          left.box.y - right.box.y ||
          left.box.x - right.box.x ||
          left.id.localeCompare(right.id),
      )
    const lineBox = boxForLines(pageLines.map(({ line }) => line))
    const sourceRegions = [
      ...new Map(
        pageLines.map(({ region }) => [region.id, region] as const),
      ).values(),
    ]
    // Some PDF text layers report a line box that ends before its final
    // painted glyph. The owning region is the conservative source boundary
    // for an exact code crop; using only the line box can clip long code lines.
    const sourceBoxes = [
      lineBox,
      ...sourceRegions.map((region) => region.box),
      ...pageObjects.map((object) => object.box),
    ]
    const left = Math.min(...sourceBoxes.map((box) => box.x))
    const top = Math.min(...sourceBoxes.map((box) => box.y))
    const right = Math.max(...sourceBoxes.map((box) => box.x + box.width))
    const bottom = Math.max(...sourceBoxes.map((box) => box.y + box.height))
    return {
      page,
      sourceLines: pageLines,
      sourceBox: {
        page,
        x: rounded(left),
        y: rounded(top),
        width: rounded(right - left),
        height: rounded(bottom - top),
        rotation: lineBox.rotation,
        method:
          pageObjects.length > 0 ? ('pdf-object' as const) : lineBox.method,
      },
      sourceObjectIds: pageObjects.map((object) => object.id),
      sourceObjectBoxes: pageObjects.map((object) =>
        normalizedLineageBox(object.box),
      ),
    }
  })
}

function retainedCaptionText(
  caption: PdfPageRegion,
  sourceLineIds: ReadonlySet<string>,
) {
  return caption.lines
    .filter((line) => !sourceLineIds.has(line.id))
    .map((line) => line.text.trim())
    .filter(Boolean)
    .join(' ')
}

function programListingBlocks(
  regions: PdfPageRegion[],
  claimedLineIds: Set<string>,
  claimedCaptionRegionIds: Set<string>,
) {
  const blocks: BoundedPreformattedBlock[] = []
  const captions = regions
    .filter(
      (region) =>
        region.kind === 'caption' &&
        /\b(?:example|generated)\s+program\b|\bprogram\s+for\b/iu.test(
          region.text,
        ) &&
        parsePdfScholarlyVisualLabel(region.text, {
          context: 'caption',
        })?.kind === 'figure',
    )
    .sort(
      (left, right) =>
        left.page - right.page ||
        left.box.y - right.box.y ||
        left.id.localeCompare(right.id),
    )
  for (const caption of captions) {
    if (claimedCaptionRegionIds.has(caption.id)) continue
    const previousCaptionBottom = Math.max(
      ...captions
        .filter(
          (candidate) =>
            candidate.page === caption.page && candidate.box.y < caption.box.y,
        )
        .map((candidate) => candidate.box.y + candidate.box.height),
      0,
    )
    const generatedHeaders = regions
      .filter(
        (region) =>
          region.page === caption.page &&
          region.box.y > previousCaptionBottom &&
          region.box.y < caption.box.y &&
          /^Generated Program$/iu.test(region.text.trim()),
      )
      .sort((left, right) => right.box.y - left.box.y)
    const headerGroup = generatedHeaders.flatMap((generated) => {
      const sameBand = regions.filter(
        (region) =>
          region.page === caption.page &&
          Math.abs(region.box.y - generated.box.y) <= 0.012,
      )
      const input = sameBand.find((region) =>
        /^Input Sequence$/iu.test(region.text.trim()),
      )
      const produced = sameBand.find((region) =>
        /^Produced Sequence$/iu.test(region.text.trim()),
      )
      return input && produced ? [[input, generated, produced]] : []
    })[0]
    if (!headerGroup) continue
    const panelTop = Math.min(...headerGroup.map((region) => region.box.y))
    const sourceRegions = regions
      .filter(
        (region) =>
          region.id !== caption.id &&
          region.page === caption.page &&
          region.lines.length > 0 &&
          region.text.trim() &&
          !['header', 'footer', 'page-number', 'caption'].includes(
            region.kind,
          ) &&
          region.box.y >= panelTop - 0.005 &&
          region.box.y + region.box.height <= caption.box.y + 0.005 &&
          horizontalBoxOverlap(region.box, caption.box) > 0,
      )
      .sort(
        (left, right) =>
          left.box.y - right.box.y ||
          left.box.x - right.box.x ||
          left.id.localeCompare(right.id),
      )
    const sourceLines = canonicalizeSourceLineOwners(
      regions,
      sourceRegions.flatMap((region) =>
        region.lines.map((line) => ({ region, line })),
      ),
    ).sort(sourceLineOrder)
    if (
      sourceLines.length < 6 ||
      sourceLines.filter(({ line }) => monospacedSourceLine(line)).length < 2 ||
      sourceLines.some(({ line }) => claimedLineIds.has(line.id))
    ) {
      continue
    }
    const parsed = parsePdfScholarlyVisualLabel(caption.text, {
      context: 'caption',
    })
    const preformatted = exactPreformattedSource(sourceLines, false)
    blocks.push({
      caption,
      label:
        parsed?.label ??
        `Code listing p${String(caption.page).padStart(3, '0')}`,
      semanticKind: 'code',
      sourceLines,
      segments: preformattedSegments(sourceLines),
      preformatted,
      evidence: [
        'source-preformatted-block',
        'caption-bounded-program-listing',
        'three-column-source-order-unresolved',
        ...preformatted.evidence,
      ],
      captionFallbackLineId: null,
    })
    claimedCaptionRegionIds.add(caption.id)
    for (const { line } of sourceLines) claimedLineIds.add(line.id)
  }
  return blocks
}

function repeatedVectorStripGroups(pages: PdfPageAnalysis[]) {
  const groups: PdfNativeObject[][] = []
  for (const page of pages) {
    const strips = (page.objects ?? [])
      .filter(
        (object) =>
          object.kind === 'vector' &&
          object.box.width >= 0.5 &&
          object.box.height > 0 &&
          object.box.height <= 0.03,
      )
      .sort(
        (left, right) =>
          left.box.y - right.box.y ||
          left.box.x - right.box.x ||
          left.id.localeCompare(right.id),
      )
    let current: PdfNativeObject[] = []
    for (const strip of strips) {
      const previous = current.at(-1)
      const connected =
        previous &&
        Math.abs(previous.box.x - strip.box.x) <= 0.01 &&
        Math.abs(previous.box.width - strip.box.width) <= 0.01 &&
        strip.box.y - (previous.box.y + previous.box.height) <= 0.02
      if (!connected) {
        if (current.length >= 3) groups.push(current)
        current = []
      }
      current.push(strip)
    }
    if (current.length >= 3) groups.push(current)
  }
  return groups
}

function vectorPanelPreformattedBlocks(
  pages: PdfPageAnalysis[],
  regions: PdfPageRegion[],
  claimedLineIds: Set<string>,
  claimedCaptionRegionIds: Set<string>,
) {
  const allLines = orderedSourceLines(regions)
  const blocks: BoundedPreformattedBlock[] = []
  for (const objects of repeatedVectorStripGroups(pages)) {
    const objectBox = {
      page: objects[0].page,
      x: Math.min(...objects.map((object) => object.box.x)),
      y: Math.min(...objects.map((object) => object.box.y)),
      width: 0,
      height: 0,
      rotation: objects[0].box.rotation,
      method: 'pdf-object' as const,
    }
    const right = Math.max(
      ...objects.map((object) => object.box.x + object.box.width),
    )
    const bottom = Math.max(
      ...objects.map((object) => object.box.y + object.box.height),
    )
    objectBox.width = rounded(right - objectBox.x)
    objectBox.height = rounded(bottom - objectBox.y)
    const panelLines = allLines.filter(
      ({ line }) =>
        line.box.page === objectBox.page &&
        !claimedLineIds.has(line.id) &&
        line.box.y + line.box.height >= objectBox.y - 0.006 &&
        line.box.y <= objectBox.y + objectBox.height + 0.006 &&
        horizontalBoxOverlap(line.box, objectBox) >
          Math.min(line.box.width, objectBox.width) * 0.5,
    )
    const monospacedCount = panelLines.filter(({ line }) =>
      monospacedSourceLine(line),
    ).length
    const monospacedRunLineCount = panelLines.filter(({ line }) =>
      substantiveSourceRuns(line).some((run) =>
        MONOSPACED_SOURCE_FONT.test(run.fontName),
      ),
    ).length
    if (
      panelLines.length < 3 ||
      monospacedCount < 1 ||
      monospacedRunLineCount < 2
    ) {
      continue
    }
    const proseAnchors = allLines
      .filter(
        ({ region, line }) =>
          line.box.page === objectBox.page &&
          line.box.y + line.box.height <= objectBox.y + 0.006 &&
          objectBox.y - (line.box.y + line.box.height) <= 0.15 &&
          !monospacedSourceLine(line) &&
          !claimedCaptionRegionIds.has(region.id),
      )
      .sort(sourceLineOrder)
    let captionOwner = proseAnchors.at(-1) ?? null
    if (
      captionOwner &&
      Math.min(...captionOwner.region.lines.map((line) => line.box.y)) <
        objectBox.y - 0.15
    ) {
      captionOwner = null
    }
    const sourceLines = panelLines
    let captionFallbackLineId: string | null = null
    if (!captionOwner) {
      const first = panelLines[0]
      if (
        !first ||
        first.region.lines.some(
          (line) =>
            line.box.y < objectBox.y - 0.006 ||
            line.box.y > objectBox.y + objectBox.height + 0.006,
        )
      ) {
        continue
      }
      captionOwner = first
      captionFallbackLineId = first.line.id
    }
    if (
      sourceLines.length < 2 ||
      sourceLines.some(({ line }) => claimedLineIds.has(line.id))
    ) {
      continue
    }
    const preformatted = exactPreformattedSource(sourceLines, false)
    blocks.push({
      caption: captionOwner.region,
      label: `Code block p${String(objectBox.page).padStart(3, '0')}-${String(
        blocks.filter((block) => block.caption.page === objectBox.page).length +
          1,
      ).padStart(3, '0')}`,
      semanticKind: 'code',
      sourceLines,
      segments: preformattedSegments(sourceLines, objects),
      preformatted,
      evidence: [
        'source-preformatted-block',
        'bounded-vector-code-panel',
        ...preformatted.evidence,
        ...(captionFallbackLineId
          ? ['fallback-source-line-caption']
          : ['source-prose-introducer']),
      ],
      captionFallbackLineId,
    })
    claimedCaptionRegionIds.add(captionOwner.region.id)
    for (const { line } of sourceLines) claimedLineIds.add(line.id)
  }
  return blocks
}

function boundedPreformattedBlocks(
  pages: PdfPageAnalysis[],
  regions: PdfPageRegion[],
  reservations: PreformattedScopeReservation = {
    lineIds: new Set<string>(),
    captionRegionIds: new Set<string>(),
  },
) {
  const claimedLineIds = new Set(reservations.lineIds)
  const claimedCaptionRegionIds = new Set(reservations.captionRegionIds)
  const sourceEvidence = sourceEvidencePreformattedBlocks(
    regions,
    claimedLineIds,
    claimedCaptionRegionIds,
  )
  const blocks = [
    ...programListingBlocks(regions, claimedLineIds, claimedCaptionRegionIds),
    ...sourceEvidence.blocks,
    ...vectorPanelPreformattedBlocks(
      pages,
      regions,
      claimedLineIds,
      claimedCaptionRegionIds,
    ),
  ]
  return {
    blocks: blocks.sort((left, right) => {
      const leftLine = left.sourceLines[0]
      const rightLine = right.sourceLines[0]
      return leftLine && rightLine
        ? sourceLineOrder(leftLine, rightLine)
        : left.label.localeCompare(right.label)
    }),
    unresolved: sourceEvidence.unresolved,
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

function renderScopeContainsCompleteFigureLineage(
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

function explicitFigureOverlayLineage(
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

function containedFigureOverlayLineage(
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

function connectedFigureReservationLineage(
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

function captionToSourceBoxGap(
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

function connectedFigureReservationContestedByTableCaption(
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

function nativeContainedFigureOverlayLineage(
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

function strongFigureOwnershipKeys(
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

function preTableFigureReservationOverlayLineage(
  candidate: VisualCandidate,
  regions: readonly PdfPageRegion[],
) {
  return (
    connectedFigureReservationLineage(candidate, regions)?.overlays ??
    nativeContainedFigureOverlayLineage(candidate, regions)
  )
}

function retainConnectedFigureReservationLineage(
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

function trimStrongFigureCandidateOverlays(
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

function captionTextBoundedFigureRetryBox(
  candidate: VisualCandidate,
  boundedSourceBox: NormalizedSourceBox,
  captionBox: NormalizedSourceBox,
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
  const left =
    nativeObjectCount >= MIN_DENSE_NATIVE_SCAFFOLD_FRAGMENT_COUNT
      ? captionBox.x
      : rounded(
          Math.max(
            0,
            Math.min(...overlayBoxes.map((sourceBox) => sourceBox.x)) -
              CAPTION_BOUNDED_PANEL_HORIZONTAL_EDGE_RETRY_PADDING,
          ),
        )
  const right =
    nativeObjectCount >= MIN_DENSE_NATIVE_SCAFFOLD_FRAGMENT_COUNT
      ? captionBox.x + captionBox.width
      : rounded(
          Math.min(
            1,
            Math.max(
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

function captionBoundedPanelRecoveryBoxes(
  candidate: VisualCandidate,
  caption: PdfPageRegion,
  regions: readonly PdfPageRegion[],
  objectKinds: ReadonlyMap<string, PdfNativeObject['kind']>,
  pageCropFailureEvidence: string | undefined,
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
      0,
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
      1,
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
  expectedOwnedSourceBoxes: readonly NormalizedSourceBox[] = [],
  expectedExcludedSourceBoxes: readonly NormalizedSourceBox[] = [],
  expectedTextOperationFilter: PdfTextOperationFilterPlan | null = null,
) {
  const actualMaskIdentity = pdfSourceExclusionMaskIdentity(
    visualAsset.sourceExclusionMask,
    sourceCropBox,
  )
  const textOperationFilterMatches =
    expectedTextOperationFilter !== null &&
    visualAsset.sourceExclusionMask?.algorithm ===
      'pdfjs-display-text-operation-filter-v2' &&
    visualAsset.sourceExclusionMask.displayOperatorAdapter ===
      expectedTextOperationFilter.displayOperatorAdapter &&
    visualAsset.sourceExclusionMask.sourceTextLedgerSha256 ===
      expectedTextOperationFilter.sourceTextLedgerSha256 &&
    JSON.stringify(visualAsset.sourceExclusionMask.ownedTextLedgerSpans) ===
      JSON.stringify(expectedTextOperationFilter.ownedTextLedgerSpans) &&
    JSON.stringify(visualAsset.sourceExclusionMask.excludedTextLedgerSpans) ===
      JSON.stringify(expectedTextOperationFilter.excludedTextLedgerSpans) &&
    visualAsset.sourceExclusionMask.ownedSourceBoxes.length ===
      expectedTextOperationFilter.ownedSourceBoxes.length &&
    visualAsset.sourceExclusionMask.excludedSourceBoxes.length ===
      expectedTextOperationFilter.excludedSourceBoxes.length &&
    expectedTextOperationFilter.ownedSourceBoxes.every((expected) =>
      visualAsset.sourceExclusionMask!.ownedSourceBoxes.some((actual) =>
        sameSourceBox(actual, expected),
      ),
    ) &&
    expectedTextOperationFilter.excludedSourceBoxes.every((expected) =>
      visualAsset.sourceExclusionMask!.excludedSourceBoxes.some((actual) =>
        sameSourceBox(actual, expected),
      ),
    )
  const trustedTextOperationFilter =
    expectedTextOperationFilter === null ||
    isTrustedPdfTextOperationFilterAsset(visualAsset)
  const expectedMaskIdentity =
    !expectedTextOperationFilter &&
    expectedOwnedSourceBoxes.length > 0 &&
    expectedExcludedSourceBoxes.length > 0
      ? pdfSourceExclusionMaskIdentity(
          {
            algorithm: 'nearest-source-box-v1',
            expansionPixels: 2,
            ownedSourceBoxes: [...expectedOwnedSourceBoxes],
            excludedSourceBoxes: [...expectedExcludedSourceBoxes],
          },
          sourceCropBox,
        )
      : null
  return (
    (!visualAsset.sourceExclusionMask ||
      (actualMaskIdentity !== null &&
        isCanonicalPdfSourceExclusionMask(
          visualAsset.sourceExclusionMask,
          sourceCropBox,
        ))) &&
    (expectedTextOperationFilter
      ? textOperationFilterMatches && trustedTextOperationFilter
      : JSON.stringify(actualMaskIdentity) ===
        JSON.stringify(expectedMaskIdentity)) &&
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
    expectedLineage.length !== sourceObjectIds.length ||
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

function sourcePageCropFailureEvidence(error: unknown) {
  if (error instanceof Error && error.name === 'AbortError') {
    return 'source-page-crop-aborted'
  }
  const message = error instanceof Error ? error.message : ''
  if (/timed out/i.test(message)) return 'source-page-crop-timeout'
  if (/source ink touching its edge/i.test(message)) {
    return 'source-page-crop-edge-contact'
  }
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

function sourceCropAttemptRequestSnapshot(
  input: PdfSourceCropAttemptRequest,
): PdfSourceCropAttemptRequest {
  return {
    kind: input.kind,
    page: input.page,
    sourceBox: { ...input.sourceBox },
    sourceObjectIds: [...input.sourceObjectIds],
    sourceBoxes: input.sourceBoxes.map((box) => ({ ...box })),
    ...(input.ownedSourceBoxes
      ? {
          ownedSourceBoxes: input.ownedSourceBoxes.map((box) => ({ ...box })),
        }
      : {}),
    ...(input.excludedSourceBoxes
      ? {
          excludedSourceBoxes: input.excludedSourceBoxes.map((box) => ({
            ...box,
          })),
        }
      : {}),
    ...(input.sourceTextOperationFilter
      ? {
          sourceTextOperationFilter: {
            ...input.sourceTextOperationFilter,
            ownedTextLedgerSpans:
              input.sourceTextOperationFilter.ownedTextLedgerSpans.map(
                (span) => ({ ...span }),
              ),
            excludedTextLedgerSpans:
              input.sourceTextOperationFilter.excludedTextLedgerSpans.map(
                (span) => ({ ...span }),
              ),
            ownedSourceBoxes:
              input.sourceTextOperationFilter.ownedSourceBoxes.map((box) => ({
                ...box,
              })),
            excludedSourceBoxes:
              input.sourceTextOperationFilter.excludedSourceBoxes.map(
                (box) => ({ ...box }),
              ),
          },
        }
      : {}),
    ...(input.tightenToSourceInk === undefined
      ? {}
      : { tightenToSourceInk: input.tightenToSourceInk }),
  }
}

function sourceCropAttemptFamilyKey(input: PdfSourceCropAttemptRequest) {
  const snapshot = sourceCropAttemptRequestSnapshot(input)
  return JSON.stringify({
    kind: snapshot.kind,
    page: snapshot.page,
    sourceObjectIds: snapshot.sourceObjectIds,
    sourceBoxes: snapshot.sourceBoxes,
    ownedSourceBoxes: snapshot.ownedSourceBoxes ?? null,
    excludedSourceBoxes: snapshot.excludedSourceBoxes ?? null,
    sourceTextOperationFilter: snapshot.sourceTextOperationFilter ?? null,
    tightenToSourceInk: snapshot.tightenToSourceInk ?? true,
  })
}

function withSourceCropAttemptProvenance(
  rasterizeFigure: PdfFigureRasterizer,
): PdfFigureRasterizer {
  const pendingEdgeAttempts = new Map<string, PdfSourceCropAttempt[]>()
  return async (input) => {
    const familyKey = sourceCropAttemptFamilyKey(input)
    const priorAttempts = pendingEdgeAttempts.get(familyKey) ?? []
    const request = sourceCropAttemptRequestSnapshot(input)
    try {
      const rasterized = await rasterizeFigure(input)
      if (!rasterized) {
        pendingEdgeAttempts.delete(familyKey)
        return null
      }
      const acceptedAttempt: PdfSourceCropAttempt = {
        schemaVersion: '1.0.0',
        sequence: priorAttempts.length + 1,
        request,
        outcome: {
          status: 'accepted',
          assetId: rasterized.id,
          assetSha256: rasterized.sha256,
        },
      }
      rasterized.sourceCropAttempts = [...priorAttempts, acceptedAttempt]
      pendingEdgeAttempts.delete(familyKey)
      return rasterized
    } catch (error) {
      if (sourcePageCropTouchesEdge(error)) {
        pendingEdgeAttempts.set(familyKey, [
          ...priorAttempts,
          {
            schemaVersion: '1.0.0',
            sequence: priorAttempts.length + 1,
            request,
            outcome: {
              status: 'edge-contact',
              evidence: 'source-page-crop-edge-contact',
            },
          },
        ])
      } else {
        pendingEdgeAttempts.delete(familyKey)
      }
      throw error
    }
  }
}

function candidateScore(
  caption: PdfPageRegion,
  label: NonNullable<ReturnType<typeof visualLabel>>,
  candidate: VisualCandidate,
  sequence: number,
  regions: PdfPageRegion[],
) {
  if (
    candidate.page !== caption.page ||
    (candidate.captionRegionId !== undefined &&
      candidate.captionRegionId !== caption.id)
  ) {
    return null
  }
  const nativeSourceBoxes = candidate.sourceObjectIds
    .map((sourceObjectId, index) =>
      sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX)
        ? null
        : candidate.sourceBoxes[index],
    )
    .filter((sourceBox): sourceBox is NormalizedSourceBox => Boolean(sourceBox))
  const nativeLeft = Math.min(...nativeSourceBoxes.map((box) => box.x))
  const nativeRight = Math.max(
    ...nativeSourceBoxes.map((box) => box.x + box.width),
  )
  const nativeWidth = nativeRight - nativeLeft
  const captionNativeOverlap = Math.max(
    0,
    Math.min(caption.box.x + caption.box.width, nativeRight) -
      Math.max(caption.box.x, nativeLeft),
  )
  const captionNativeOverlapRatio =
    nativeWidth > 0 && caption.box.width > 0
      ? captionNativeOverlap / Math.min(nativeWidth, caption.box.width)
      : 0
  const hasCaptionMisalignedNativeFragment = nativeSourceBoxes.some(
    (sourceBox) => horizontalOverlapRatio(caption.box, sourceBox) < 0.35,
  )
  if (
    label.kind === 'figure' &&
    caption.box.width < MIN_CROSS_COLUMN_FIGURE_SPAN &&
    (captionNativeOverlapRatio < 0.35 ||
      (hasCaptionMisalignedNativeFragment &&
        !candidate.evidence?.some((item) =>
          [
            'connected-native-scaffold',
            'caption-bounded-semantic-envelope',
          ].includes(item),
        )))
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
  if (candidate.evidence?.includes('caption-bounded-semantic-envelope')) {
    score += 0.1
    evidence.push('caption-bounded-envelope-proof')
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
    `\\b${label.label
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+')}\\b`,
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
  const captionBoundedEnvelopes = allScored.filter((candidate) =>
    candidate.candidate.evidence?.includes('caption-bounded-semantic-envelope'),
  )
  // A caption-specific semantic envelope carries stricter source ownership
  // proof than loose child fragments in the same lane. Keeping both in the
  // ambiguity set would let those child fragments veto the proved parent.
  const candidatePool =
    captionBoundedEnvelopes.length > 0 ? captionBoundedEnvelopes : allScored
  const directionScored =
    label.kind === 'figure' &&
    candidatePool.some((candidate) =>
      candidate.evidence.includes('object-above-caption'),
    )
      ? candidatePool.filter((candidate) =>
          candidate.evidence.includes('object-above-caption'),
        )
      : candidatePool
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
    ...(scope.fallback === 'source-preserved'
      ? ['source-preserved-table-fallback']
      : []),
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
      ...(scope.evidence.some(
        (item) => item.code === 'supplemental-equation-cell-shard',
      )
        ? ['supplemental-equation-cell-shard']
        : []),
    ],
  }
}

function matchTableScopeResolution(
  resolution: PdfTableScopeResolution,
  caption: PdfPageRegion,
  regions: PdfPageRegion[],
  objectAssetIds: ReadonlyMap<string, string | null>,
): ReturnType<typeof matchCandidate> {
  const scopes =
    resolution.candidates.length > 0
      ? resolution.candidates
      : (resolution.fallbackCandidates ?? [])
  const scored = scopes.map((scope) => {
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

type PdfVisualMatchCandidateWithOwnershipExtent = PdfVisualMatchCandidate & {
  sourceLineIds: string[]
  sourceText: string
  ownershipExtentSha256: string
}

function matchRecord(
  scored: ReturnType<typeof matchCandidate>['scored'][number],
  regions: readonly PdfPageRegion[],
): PdfVisualMatchCandidateWithOwnershipExtent {
  return {
    sourceRegionIds: scored.candidate.sourceRegionIds,
    sourceLineIds: [...(scored.candidate.sourceLineIds ?? [])],
    sourceObjectIds: scored.candidate.sourceObjectIds,
    assetIds: scored.candidate.assetIds,
    score: scored.score,
    evidence: scored.evidence,
    sourceBoxes: scored.candidate.sourceBoxes,
    sourceText: scored.candidate.sourceText,
    ownershipExtentSha256: pdfVisualOwnershipExtentSha256(
      regions,
      scored.candidate.sourceRegionIds,
      scored.candidate.sourceLineIds,
    ),
  }
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

function unpublishableEquationTranscriptText(text: string) {
  return text.includes('\ufffd') || sanitizeXmlText(text) !== text
}

function unresolvedMathExtensionRun(
  run: PdfPageRegion['lines'][number]['runs'][number],
) {
  return (
    sourceMathFontProvenance(run.fontName)?.role === 'math-extension' &&
    (unpublishableEquationTranscriptText(run.text) ||
      pdfFontTextRequiresStructuralReconstruction(run.text, run.fontName))
  )
}

function unresolvedMathExtensionRegion(region: PdfPageRegion) {
  return region.lines.some((line) => line.runs.some(unresolvedMathExtensionRun))
}

function unreliableMathExtensionRun(
  run: PdfPageRegion['lines'][number]['runs'][number],
) {
  return (
    sourceMathFontProvenance(run.fontName)?.role === 'math-extension' &&
    (unresolvedMathExtensionRun(run) || /^[A-Za-z]$/u.test(run.text))
  )
}

function mathExtensionGlyphFragment(region: PdfPageRegion) {
  const runs = region.lines.flatMap((line) => line.runs)
  return (
    runs.length > 0 &&
    runs.every(
      (run) =>
        sourceMathFontProvenance(run.fontName)?.role === 'math-extension',
    )
  )
}

function sourceMathExtensionScaffoldFragment(region: PdfPageRegion) {
  if (
    region.lines.length !== 1 ||
    region.box.width > 0.18 ||
    region.box.height > 0.04
  ) {
    return false
  }
  const runs = region.lines[0].runs.filter((run) => run.text.trim())
  const extensionRuns = runs.filter(
    (run) => sourceMathFontProvenance(run.fontName)?.role === 'math-extension',
  )
  return (
    extensionRuns.length >= 2 &&
    runs.length > extensionRuns.length &&
    runs
      .filter(
        (run) =>
          sourceMathFontProvenance(run.fontName)?.role !== 'math-extension',
      )
      .every((run) => /^[\s.\u2026\d]+$/u.test(run.text))
  )
}

function contextualNeutralVerticalEllipsisFragment(
  region: PdfPageRegion,
  ownedRegions: readonly PdfPageRegion[],
) {
  const text = region.text.replace(/\s+/gu, '')
  if (
    !/^(?:\.{3}|\u2026)$/u.test(text) ||
    region.lines.length !== 1 ||
    region.box.width > 0.02 ||
    region.box.height < 0.012 ||
    region.box.height > 0.04 ||
    ownedRegions.length === 0
  ) {
    return false
  }
  const runs = region.lines[0].runs.filter((run) => run.text.trim())
  if (
    runs.length === 0 ||
    !runs.every((run) => /^[.\u2026]+$/u.test(run.text.trim()))
  ) {
    return false
  }
  const extensionRuns = ownedRegions.flatMap((owned) =>
    owned.lines.flatMap((line) =>
      line.runs.filter(
        (run) =>
          run.text.trim() &&
          sourceMathFontProvenance(run.fontName)?.role === 'math-extension',
      ),
    ),
  )
  const centerX = region.box.x + region.box.width / 2
  const centerY = region.box.y + region.box.height / 2
  const verticallyEnclosesCenter = (
    candidates: readonly PdfPageRegion['lines'][number]['runs'][number][],
  ) =>
    candidates.length > 0 &&
    Math.min(...candidates.map((run) => run.y)) <= centerY &&
    Math.max(...candidates.map((run) => run.y + run.height)) >= centerY
  const leftColumn = extensionRuns.filter(
    (run) =>
      run.x + run.width <= centerX && centerX - (run.x + run.width) <= 0.12,
  )
  const rightColumn = extensionRuns.filter(
    (run) => run.x >= centerX && run.x - centerX <= 0.12,
  )
  return (
    verticallyEnclosesCenter(leftColumn) &&
    verticallyEnclosesCenter(rightColumn)
  )
}

function unresolvedMathExtensionGlyphFragment(region: PdfPageRegion) {
  return (
    mathExtensionGlyphFragment(region) && unresolvedMathExtensionRegion(region)
  )
}

function equationTranscriptResolved(regions: PdfPageRegion[]) {
  return !regions.some((region) =>
    region.lines.some(
      (line) =>
        unpublishableEquationTranscriptText(line.text) ||
        line.runs.some(unreliableMathExtensionRun),
    ),
  )
}

function sourceEquationLineText(regions: PdfPageRegion[]) {
  return regions
    .flatMap((region) => region.lines)
    .sort(
      (left, right) =>
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.id.localeCompare(right.id),
    )
    .map((line) => line.text.replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join(' ')
}

type SourceMathFontProvenance = {
  family: 'computer-modern' | 'latin-modern' | 'stix'
  role: 'roman' | 'math-glyph' | 'math-extension'
}

function sourceMathFontProvenance(
  fontName: string,
): SourceMathFontProvenance | null {
  if (/(?:^|[+_-])CMR\d*(?:$|[+_-])/iu.test(fontName)) {
    return { family: 'computer-modern', role: 'roman' }
  }
  if (/(?:^|[+_-])CMEX\d*(?:$|[+_-])/iu.test(fontName)) {
    return { family: 'computer-modern', role: 'math-extension' }
  }
  if (/(?:^|[+_-])(?:CMMI|CMSY|MSAM|MSBM)\d*(?:$|[+_-])/iu.test(fontName)) {
    return { family: 'computer-modern', role: 'math-glyph' }
  }
  if (
    /(?:^|[+_-])LMRoman\d*(?:-(?:Regular|Bold|Italic|BoldItalic))?(?:$|[+_-])/iu.test(
      fontName,
    )
  ) {
    return { family: 'latin-modern', role: 'roman' }
  }
  if (
    /(?:^|[+_-])LMMathExtension\d*(?:-Regular)?(?:$|[+_-])/iu.test(fontName)
  ) {
    return { family: 'latin-modern', role: 'math-extension' }
  }
  if (
    /(?:^|[+_-])LMMath(?:Italic|Symbols)\d*(?:-Regular)?(?:$|[+_-])/iu.test(
      fontName,
    )
  ) {
    return { family: 'latin-modern', role: 'math-glyph' }
  }
  if (stixMathFont(fontName)) {
    return { family: 'stix', role: 'math-glyph' }
  }
  return null
}

function computerOrLatinModernMathFont(fontName: string) {
  const provenance = sourceMathFontProvenance(fontName)
  return (
    provenance?.family === 'computer-modern' ||
    provenance?.family === 'latin-modern'
  )
}

function sourceMathRomanFont(fontName: string) {
  return sourceMathFontProvenance(fontName)?.role === 'roman'
}

function justifiedUprightSourceMathToken(value: string) {
  return /^(?:arg|cosh?|det|diag|dim|exp|gcd|im|lim|log|max|min|mod|pr|re|sinh?|sqrt|tanh?|var|d[p-z])$/iu.test(
    value,
  )
}

function hasUnsupportedSourceMathRomanWord(
  runs: readonly PdfPageRegion['lines'][number]['runs'][number][],
) {
  let token = ''
  const flush = () => {
    const unsupported =
      Array.from(token).length >= 2 && !justifiedUprightSourceMathToken(token)
    token = ''
    return unsupported
  }
  for (const run of runs) {
    if (!sourceMathRomanFont(run.fontName)) {
      if (flush()) return true
      continue
    }
    // PDF.js can split adjacent upright operators into separate Roman runs
    // without retaining the intervening source space (for example
    // `arg max` followed by `log Pr`). A complete allowlisted operator is a
    // safe lexical boundary; an arbitrary split word remains joined and is
    // still rejected by the prose guard.
    if (token && justifiedUprightSourceMathToken(token) && flush()) return true
    for (const character of run.text) {
      if (/\p{L}/u.test(character) && !/\p{Lm}/u.test(character)) {
        token += character
      } else if (flush()) {
        return true
      }
    }
  }
  return flush()
}

function stixMathFont(fontName: string) {
  return /(?:^|[+_-])STIXMath(?:[A-Za-z]*)?(?:$|[+_-])/iu.test(fontName)
}

function knownSourceMathFont(fontName: string) {
  return sourceMathFontProvenance(fontName) !== null
}

function lineHasSourceScriptGeometry(line: PdfPageRegion['lines'][number]) {
  const runs = line.runs.filter((run) => run.text.trim())
  if (runs.length < 2) return false
  const maximumFontSize = Math.max(...runs.map((run) => run.fontSize))
  const baselineRuns = runs.filter(
    (run) => run.fontSize >= maximumFontSize * 0.9,
  )
  if (baselineRuns.length === 0) return false
  const baselineCenter =
    baselineRuns.reduce((total, run) => total + run.y + run.height / 2, 0) /
    baselineRuns.length
  const baselineHeight =
    baselineRuns.reduce((total, run) => total + run.height, 0) /
    baselineRuns.length
  const threshold = Math.max(0.0015, baselineHeight * 0.12)
  return runs.some(
    (run) =>
      knownSourceMathFont(run.fontName) &&
      run.fontSize <= maximumFontSize * 0.82 &&
      Math.abs(run.y + run.height / 2 - baselineCenter) > threshold,
  )
}

function lineHasCompactSourceScriptIdentifier(
  line: PdfPageRegion['lines'][number],
) {
  const text = line.text.replace(/\s+/gu, '')
  const runs = line.runs.filter((run) => run.text.trim())
  if (
    runs.length < 2 ||
    !/^[\p{L}\p{N}]{2,8}$/u.test(text) ||
    !runs.every((run) => knownSourceMathFont(run.fontName))
  ) {
    return false
  }
  const maximumFontSize = Math.max(...runs.map((run) => run.fontSize))
  const minimumFontSize = Math.min(...runs.map((run) => run.fontSize))
  return maximumFontSize > 0 && minimumFontSize <= maximumFontSize * 0.82
}

function lineHasUnencodedSourceScriptGeometry(
  line: PdfPageRegion['lines'][number],
) {
  const runs = line.runs.filter((run) => run.text.trim())
  if (runs.length < 2) return false
  const maximumFontSize = Math.max(...runs.map((run) => run.fontSize))
  const baselineRuns = runs.filter(
    (run) => run.fontSize >= maximumFontSize * 0.9,
  )
  if (baselineRuns.length === 0) return false
  const baselineCenter =
    baselineRuns.reduce((total, run) => total + run.y + run.height / 2, 0) /
    baselineRuns.length
  const baselineHeight =
    baselineRuns.reduce((total, run) => total + run.height, 0) /
    baselineRuns.length
  const threshold = Math.max(0.0015, baselineHeight * 0.12)
  const normalizedLine = line.text.replace(/\s+/gu, '')
  return runs.some((run) => {
    const sourceToken = run.text.replace(/\s+/gu, '')
    const isScriptRun =
      run.fontSize <= maximumFontSize * 0.82 &&
      Math.abs(run.y + run.height / 2 - baselineCenter) > threshold
    if (!isScriptRun || !sourceToken) return false
    const unicodeScriptToken = /^[\u00b2\u00b3\u00b9\u2070-\u209c]+$/u.test(
      sourceToken,
    )
    const explicitlyMarked =
      normalizedLine.includes(`_${sourceToken}`) ||
      normalizedLine.includes(`^{${sourceToken}}`) ||
      normalizedLine.includes(`_{${sourceToken}}`) ||
      normalizedLine.includes(`^${sourceToken}`)
    return !unicodeScriptToken && !explicitlyMarked
  })
}

function knownSourceMathGlyphFont(fontName: string) {
  const role = sourceMathFontProvenance(fontName)?.role
  return role === 'math-glyph' || role === 'math-extension'
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

export function equationSourceRunOwnershipKey(
  run: PdfPageRegion['lines'][number]['runs'][number],
) {
  return JSON.stringify({
    page: run.page,
    x: run.x,
    y: run.y,
    width: run.width,
    height: run.height,
    rotation: run.rotation,
    method: run.method,
    text: run.text,
    fontName: run.fontName,
    fontSize: run.fontSize,
    confidence: run.confidence,
    bold: run.bold ?? null,
    italic: run.italic ?? null,
    sourceSequenceIndex: run.sourceSequenceIndex ?? null,
    sourceSemanticAdmission: run.sourceSemanticAdmission ?? null,
    sourceWhitespaceBefore: run.sourceWhitespaceBefore ?? null,
    sourceWhitespacePredecessorIndex:
      run.sourceWhitespacePredecessorIndex ?? null,
    sourceTextPaint: run.sourceTextPaint
      ? {
          algorithm: run.sourceTextPaint.algorithm,
          textLedgerSha256: run.sourceTextPaint.textLedgerSha256,
          normalizedTextStart: run.sourceTextPaint.normalizedTextStart,
          normalizedTextEnd: run.sourceTextPaint.normalizedTextEnd,
          // The full-page operator ledger remains crop attestation evidence;
          // local ownership binds only the exact run span and its operations.
          operationIndexes: [...run.sourceTextPaint.operationIndexes],
          filterableOperationIndexes: [
            ...run.sourceTextPaint.filterableOperationIndexes,
          ],
        }
      : null,
  })
}

export function pdfVisualOwnershipExtentSha256(
  regions: readonly PdfPageRegion[],
  sourceRegionIds: readonly string[],
  sourceLineIds?: readonly string[],
) {
  const sourceRegionIdSet = new Set(sourceRegionIds)
  const explicitSourceLineIds = new Set(sourceLineIds ?? [])
  const ownershipTuples = regions
    .filter((region) => sourceRegionIdSet.has(region.id))
    .map((region) => ({
      regionId: region.id,
      lines: region.lines
        .filter(
          (line) =>
            explicitSourceLineIds.size === 0 ||
            explicitSourceLineIds.has(line.id),
        )
        .map((line) => ({
          lineId: line.id,
          sourceRunKeys: line.runs.map(equationSourceRunOwnershipKey).sort(),
        }))
        .sort((left, right) => left.lineId.localeCompare(right.lineId)),
    }))
    .sort((left, right) => left.regionId.localeCompare(right.regionId))
  return sha256HexSync(
    JSON.stringify({
      algorithm: 'pdf-visual-ownership-extent-v1',
      sourceRegionIds: [...sourceRegionIds].sort(),
      ownershipTuples,
    }),
  )
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
          const scopedRegions = availableTableRegions.filter((region) =>
            scope.sourceRegionIds.includes(region.id),
          )
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
              })
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
    const best = matchedCandidate
      ? nativeOnlyFigureCandidate(matchedCandidate, regions, objectAssetIds)
      : undefined
    const figureLineageConflictsPriorOwnership =
      best?.kind === 'figure' &&
      (best.sourceObjectIds.some((sourceObjectId) =>
        consumedSourceObjectIds.has(sourceObjectId),
      ) ||
        containedFigureOverlayLineage(best, regions).some((overlay) =>
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
      best?.renderBox ??
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
      ? paddedUnionBox(best.renderBox ? [best.renderBox] : best.sourceBoxes)
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
          best.sourceObjectIds = [...scopedSourceLineage.sourceObjectIds]
          best.sourceBoxes = scopedSourceLineage.sourceBoxes.map((box) => ({
            ...box,
          }))
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
      for (const sourceObjectId of best!.sourceObjectIds) {
        consumedSourceObjectIds.add(sourceObjectId)
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

  const algorithmCountByPage = new Map<number, number>()
  onProgress?.({
    phase: 'semantic-promotion',
    completed: 0,
    total: regions.length,
    message: `Indexing bounded algorithm evidence across ${regions.length} source regions…`,
    checkpoint: 'algorithm-block-discovery',
  })
  await yieldPdfVisualTask(signal)
  const algorithms = boundedAlgorithmBlocks(regions, consumedRegionIds)
  for (const [algorithmIndex, algorithm] of algorithms.entries()) {
    if (
      algorithmIndex > 0 &&
      algorithmIndex % PDF_VISUAL_COOPERATIVE_BATCH_SIZE === 0
    ) {
      onProgress?.({
        phase: 'semantic-promotion',
        completed: algorithmIndex,
        total: algorithms.length,
        message: `Resolving bounded algorithm blocks ${algorithmIndex} of ${algorithms.length}…`,
      })
      await yieldPdfVisualTask(signal)
    }
    const pageSequence =
      (algorithmCountByPage.get(algorithm.caption.page) ?? 0) + 1
    algorithmCountByPage.set(algorithm.caption.page, pageSequence)
    const sourceObjectId = `algorithm-source-p${String(
      algorithm.caption.page,
    ).padStart(3, '0')}-${String(pageSequence).padStart(3, '0')}`
    const selectedLineIds = new Set([
      ...algorithm.caption.lines.map((line) => line.id),
      ...algorithm.sourceLineIds,
    ])
    let sourceCropBox = neighborBoundedCropBoxes(
      algorithm.sourceBox,
      selectedLineIds,
      regions,
      ALGORITHM_SOURCE_CROP_PADDING,
    )[0]
    let sourceCrop: PdfVisualAsset | null = null
    let cropTouchedEdge = false
    let adaptivePaddingRetry = false
    if (rasterizeFigure) {
      sourceCrop = await rasterizeFigure({
        kind: 'figure',
        page: algorithm.caption.page,
        sourceBox: sourceCropBox,
        sourceObjectIds: [sourceObjectId],
        sourceBoxes: [algorithm.sourceBox],
      }).catch((error: unknown) => {
        cropTouchedEdge = sourcePageCropTouchesEdge(error)
        return null
      })
      const attemptedBoxes = [sourceCropBox]
      retryAlgorithmCrop: for (const padding of ALGORITHM_SOURCE_CROP_RETRY_PADDINGS) {
        if (sourceCrop || !cropTouchedEdge) break
        const retryBox = neighborBoundedCropBoxes(
          algorithm.sourceBox,
          selectedLineIds,
          regions,
          padding,
        )[0]
        if (
          attemptedBoxes.some((attempted) => sameSourceBox(attempted, retryBox))
        ) {
          continue
        }
        attemptedBoxes.push(retryBox)
        let retryTouchedEdge = false
        const retryCrop = await rasterizeFigure({
          kind: 'figure',
          page: algorithm.caption.page,
          sourceBox: retryBox,
          sourceObjectIds: [sourceObjectId],
          sourceBoxes: [algorithm.sourceBox],
        }).catch((error: unknown) => {
          retryTouchedEdge = sourcePageCropTouchesEdge(error)
          return null
        })
        cropTouchedEdge = retryTouchedEdge
        if (retryCrop) {
          sourceCropBox = retryBox
          sourceCrop = retryCrop
          adaptivePaddingRetry = true
          break retryAlgorithmCrop
        }
        if (!retryTouchedEdge) break retryAlgorithmCrop
      }
    }
    const cropMatched = Boolean(
      sourceCrop &&
      completeSourcePageCropAsset(
        sourceCrop,
        'figure',
        [sourceObjectId],
        [algorithm.sourceBox],
        sourceCropBox,
      ),
    )
    if (sourceCrop && cropMatched) mergeAsset(assetStore, sourceCrop)
    const evidence = [
      'source-algorithm-block',
      'bounded-source-geometry',
      'contiguous-algorithm-line-markers',
      'source-text-transcript-unresolved',
      ...(adaptivePaddingRetry ? ['source-page-crop-adaptive-padding'] : []),
      ...(cropMatched
        ? ['source-page-crop']
        : ['source-rendition-unavailable', 'unresolved-visual-text-owned']),
    ]
    // The explicit Algorithm heading is the caption for this visual owner.
    // Promotion happens only after a Require/Input anchor, a contiguous 1..N
    // marker sequence, and a terminal line prove the complete bounded panel.
    algorithm.caption.kind = 'caption'
    if (cropMatched) {
      for (const region of algorithm.sourceRegions) {
        consumedRegionIds.add(region.id)
        for (const line of region.lines) consumedLineIds.add(line.id)
      }
    }
    relationships.push({
      id: '',
      kind: 'figure',
      semanticKind: 'algorithm',
      label: algorithm.label,
      captionRegionId: algorithm.caption.id,
      sourceRegionIds: algorithm.sourceRegions.map((region) => region.id),
      sourceLineIds: [...algorithm.sourceLineIds],
      sourceObjectIds: cropMatched ? [sourceObjectId] : [],
      assetIds: cropMatched ? [sourceCrop!.id] : [],
      status: cropMatched ? 'matched' : 'unresolved',
      confidence: Math.min(
        algorithm.caption.confidence,
        ...algorithm.sourceRegions.map((region) => region.confidence),
      ),
      evidence,
      candidates: [
        {
          sourceRegionIds: algorithm.sourceRegions.map((region) => region.id),
          sourceObjectIds: [sourceObjectId],
          assetIds: cropMatched ? [sourceCrop!.id] : [],
          score: algorithm.caption.confidence,
          evidence,
          sourceBoxes: [algorithm.sourceBox],
        },
      ],
      sourceBoxes: [algorithm.caption.box, algorithm.sourceBox],
      // A crop conserves the exact printed pseudocode, but the PDF text layer
      // does not prove indentation or continuation ownership. Never count its
      // flattened extraction as canonical text. On a failed crop, retain it
      // only as an explicitly unresolved recovery transcript.
      sourceText: cropMatched ? '' : algorithm.sourceText,
      altText: algorithm.caption.text,
      altTextSource: 'caption',
      canonicalNodeId: null,
      captionNodeId: null,
    })
    if (!cropMatched) {
      diagnostics.push({
        code: 'UNRESOLVED_ALGORITHM_BLOCK',
        severity: 'error',
        page: algorithm.caption.page,
        message: `${algorithm.label} has a proved bounded source panel, but no exact source crop is available; its numbered lines remain in canonical text flow while the visual relationship stays unresolved.`,
        sourceBoxes: [algorithm.caption.box, algorithm.sourceBox],
        target: {
          regionIds: algorithm.sourceRegions.map((region) => region.id),
          markerId: null,
        },
      })
    }
  }

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
    ...(tableCandidateProvider ? { tableCandidateReceipts } : {}),
  }
}
