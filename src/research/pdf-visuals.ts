import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfPreformattedSource,
  PdfPreformattedSourceLine,
  PdfVisualAsset,
  PdfVisualMatchCandidate,
  PdfVisualRelationship,
  ReconstructionDiagnostic,
} from './import-types'
import { pdfFontTextRequiresStructuralReconstruction } from './pdf-font-text'
import {
  detectHierarchicalTableWithinProvenScope,
  detectTableNearCaption,
  detectTableWithinProvenScope,
  type PdfDetectedTableGrid,
} from './pdf-table-detection'
import {
  resolvePdfTableScope,
  type PdfTableScope,
  type PdfTableScopeResolution,
} from './pdf-table-scope'
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
  isValidSourcePageCropPayload,
  type CanonicalTable,
} from './visual-assets'
import { sanitizeXmlText } from './publication-integrity'

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
  ownedSourceBoxes?: NormalizedSourceBox[]
}) => Promise<PdfVisualAsset | null>

export type PdfPartialRegionLineSelection = {
  regionId: string
  consumedLineIds: string[]
  retainedLineIds: string[]
}

const MIN_COMPOSITE_FIGURE_FRAGMENTS = 2
const TEXT_OVERLAY_PREFIX = 'text-overlay:'
const FIGURE_OVERLAY_BOX_TOLERANCE = 0.004
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
const TABLE_SOURCE_CROP_RETRY_PADDINGS = [
  0.006, 0.008, 0.01, 0.012, 0.014, 0.016, 0.02, 0.024, 0.028, 0.032,
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
  if (captionSeparates(left, right, captions)) return false
  if (narrowCaptionClaimsOneColumn(left, right, captions)) return false
  if (
    adjacentPanelLabelOverlays([left, right], regions, captions).length === 2
  ) {
    return true
  }
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

function repeatedRectangleFallbackObjectIds(pages: PdfPageAnalysis[]) {
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
  return new Set(
    rectangles.flatMap((object, objectIndex) => {
      const repeated = rectangles.some((candidate, candidateIndex) => {
        if (candidateIndex === objectIndex) return false
        const smallerArea = Math.min(
          object.box.width * object.box.height,
          candidate.box.width * candidate.box.height,
        )
        return (
          candidate.assetId === object.assetId ||
          sameRepeatedGeometry(object, candidate) ||
          (object.page === candidate.page &&
            smallerArea > 0 &&
            intersectionArea(object.box, candidate.box) / smallerArea >=
              MIN_REPEATED_RECTANGLE_OVERLAP)
        )
      })
      return repeated ? [object.id] : []
    }),
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
  const repeatedRectangleObjectIds = repeatedRectangleFallbackObjectIds(pages)
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

function reusedPageBackdropObjectIds(pages: PdfPageAnalysis[]) {
  const repeatedRectangleObjectIds = repeatedRectangleFallbackObjectIds(pages)
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

function reusedPanelClipObjectIds(pages: PdfPageAnalysis[]) {
  const repeatedRectangleObjectIds = repeatedRectangleFallbackObjectIds(pages)
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
        !strongHierarchicalSectionHeading(region.text) &&
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
  const components: PdfPageRegion[][] = []
  while (remaining.size > 0) {
    const seed = remaining.values().next().value as PdfPageRegion
    remaining.delete(seed)
    const component = [seed]
    for (let index = 0; index < component.length; index += 1) {
      for (const candidate of [...remaining]) {
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
  const repeatedPageFurnitureIds = repeatedTopPageFurnitureRegionIds(regions)
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
        !strongHierarchicalSectionHeading(region.text) &&
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

function captionBoundedSemanticEnvelopeCandidates(
  figureRegions: PdfPageRegion[],
  regions: PdfPageRegion[],
  captions: PdfPageRegion[],
  pageBackdropObjectIds: ReadonlySet<string>,
  panelClipObjectIds: ReadonlySet<string>,
) {
  const orderedCaptions = [...captions].sort(
    (left, right) =>
      left.page - right.page ||
      left.box.y - right.box.y ||
      left.box.x - right.box.x ||
      left.id.localeCompare(right.id),
  )
  const repeatedPageFurnitureRegionIds =
    repeatedTopPageFurnitureRegionIds(regions)
  return orderedCaptions.flatMap<VisualCandidate>((caption, captionIndex) => {
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
    const denseGridRegions = denseGridPool.filter((region) => {
      const centerX = region.box.x + region.box.width / 2
      const centerY = region.box.y + region.box.height / 2
      const sameColumnCount = denseGridPool.filter(
        (candidate) =>
          candidate !== region &&
          Math.abs(candidate.box.x + candidate.box.width / 2 - centerX) <= 0.06,
      ).length
      const sameRowCount = denseGridPool.filter(
        (candidate) =>
          candidate !== region &&
          Math.abs(candidate.box.y + candidate.box.height / 2 - centerY) <=
            0.035,
      ).length
      return (
        sameColumnCount >= MIN_CAPTION_ENVELOPE_GRID_ROW_COUNT - 1 &&
        sameRowCount >= MIN_CAPTION_ENVELOPE_GRID_COLUMN_COUNT - 1
      )
    })
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
        compatibleCaptionLaneColumns(region.column, caption.column) &&
        !repeatedPageFurnitureRegionIds.has(region.id) &&
        !strongHierarchicalSectionHeading(region.text) &&
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
          !strongHierarchicalSectionHeading(region.text) &&
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
      return ordered.reduce(
        (clusters, value) =>
          clusters.length === 0 ||
          value - clusters[clusters.length - 1] > tolerance
            ? [...clusters, value]
            : clusters,
        [] as number[],
      ).length
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
  })
}

function figureCandidates(
  regions: PdfPageRegion[],
  captions: PdfPageRegion[],
  decorativeObjectIds: Set<string>,
  pageBackdropObjectIds: Set<string>,
  panelClipObjectIds: Set<string>,
) {
  const repeatedPageFurnitureIds = repeatedTopPageFurnitureRegionIds(regions)
  const topPageFurnitureSources = topPageFurnitureTextSources(regions)
  const figureRegions = regions.filter(
    (region) => region.kind === 'figure' && region.nativeObjectIds.length > 0,
  )
  const remaining = figureRegions.filter(
    (region) =>
      !region.nativeObjectIds.some((id) => pageBackdropObjectIds.has(id)) &&
      (!isDecorativeVectorArtifact(region, decorativeObjectIds) ||
        isCompositeScaffold(region, figureRegions)),
  )
  const groups: PdfPageRegion[][] = []
  while (remaining.length > 0) {
    const group = [remaining.shift()!]
    for (let index = 0; index < remaining.length;) {
      if (
        group.some((region) =>
          connected(region, remaining[index], regions, captions),
        )
      ) {
        group.push(remaining.splice(index, 1)[0])
        index = 0
      } else {
        index += 1
      }
    }
    groups.push(group)
  }
  const connectedCandidates = groups
    .map<VisualCandidate>((group) => {
      const panelLabelOverlays = adjacentPanelLabelOverlays(
        group,
        regions,
        captions,
      )
      const flowOverlays = [
        ...new Map(
          [
            ...captionBoundedReadingOrderOverlays(
              group,
              figureRegions,
              regions,
              captions,
            ),
            ...panelLabelOverlays,
          ].map((region) => [region.id, region]),
        ).values(),
      ]
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
      const pageFurnitureText = regions.filter(
        (region) =>
          region.page === group[0].page &&
          region.nativeObjectIds.length === 0 &&
          region.lines.length > 0 &&
          region.text.trim().length > 0 &&
          (['header', 'footer', 'page-number'].includes(region.kind) ||
            repeatedPageFurnitureIds.has(region.id)),
      )
      pageFurnitureText.push(
        ...topPageFurnitureSources.filter(
          (region) => region.page === group[0].page,
        ),
      )
      const uncontaminatedGroup = group.filter(
        (region) =>
          !materiallyOverlapsSourceText(region, [
            ...unclaimedReadingOrderText,
            ...pageFurnitureText,
          ]),
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
  const semanticEnvelopes = captionBoundedSemanticEnvelopeCandidates(
    figureRegions,
    regions,
    captions,
    pageBackdropObjectIds,
    panelClipObjectIds,
  )
  return [...connectedCandidates, ...semanticEnvelopes].sort(
    (left, right) =>
      left.page - right.page ||
      Math.min(...left.sourceBoxes.map((box) => box.y)) -
        Math.min(...right.sourceBoxes.map((box) => box.y)) ||
      (left.captionRegionId ?? '').localeCompare(right.captionRegionId ?? ''),
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

function hasOverlappingUnownedEquationText(
  ownedSourceBoxes: readonly NormalizedSourceBox[],
  sourceLineIds: ReadonlySet<string>,
  regions: PdfPageRegion[],
) {
  if (ownedSourceBoxes.length === 0) return false
  const sourcePage = ownedSourceBoxes[0].page
  const seenLineIds = new Set<string>()
  return regions.some((region) =>
    region.page !== sourcePage
      ? false
      : region.lines.some((line) => {
          if (sourceLineIds.has(line.id) || seenLineIds.has(line.id)) {
            return false
          }
          seenLineIds.add(line.id)
          const unownedBoxes =
            line.runs.length > 0
              ? line.runs
                  .filter((run) => run.text.trim())
                  .map((run) => ({
                    page: run.page,
                    x: run.x,
                    y: run.y,
                    width: run.width,
                    height: run.height,
                    rotation: run.rotation,
                    method: run.method,
                  }))
              : line.text.trim()
                ? [line.box]
                : []
          return unownedBoxes.some((unowned) =>
            ownedSourceBoxes.some((owned) =>
              materiallyOverlappingSourceBoxes(owned, unowned),
            ),
          )
        }),
  )
}

function hasUnownedSourceTextInEquationCrop(
  sourceCropBox: NormalizedSourceBox,
  sourceLineIds: ReadonlySet<string>,
  regions: PdfPageRegion[],
) {
  const seenLineIds = new Set<string>()
  return regions.some((region) =>
    region.page !== sourceCropBox.page
      ? false
      : region.lines.some((line) => {
          if (sourceLineIds.has(line.id) || seenLineIds.has(line.id)) {
            return false
          }
          seenLineIds.add(line.id)
          const unownedBoxes =
            line.runs.length > 0
              ? line.runs
                  .filter((run) => run.text.trim())
                  .map((run) => ({
                    page: run.page,
                    x: run.x,
                    y: run.y,
                    width: run.width,
                    height: run.height,
                    rotation: run.rotation,
                    method: run.method,
                  }))
              : line.text.trim()
                ? [line.box]
                : []
          return unownedBoxes.some((unowned) =>
            materiallyOverlappingSourceBoxes(sourceCropBox, unowned),
          )
        }),
  )
}

function neighborBoundedCropBoxes(
  sourceBox: NormalizedSourceBox,
  sourceLineIds: ReadonlySet<string>,
  regions: PdfPageRegion[],
  desiredPadding: number,
  neighborGapFraction = 0.25,
) {
  const desired = {
    left: Math.max(0, sourceBox.x - desiredPadding),
    top: Math.max(0, sourceBox.y - desiredPadding),
    right: Math.min(1, sourceBox.x + sourceBox.width + desiredPadding),
    bottom: Math.min(1, sourceBox.y + sourceBox.height + desiredPadding),
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
    ...neighboringLines
      .filter(
        (line) =>
          line.box.x + line.box.width <= sourceBox.x &&
          verticalBoxOverlap(line.box, sourceBox) > 0,
      )
      .map((line) => line.box.x + line.box.width),
    0,
  )
  const nearestRight = Math.min(
    ...neighboringLines
      .filter(
        (line) =>
          line.box.x >= sourceBox.x + sourceBox.width &&
          verticalBoxOverlap(line.box, sourceBox) > 0,
      )
      .map((line) => line.box.x),
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
    /\bend\s+(?:algorithm|procedure)\b/iu.test(value)
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
      /^(?:Require|Input)\s*:/iu.test(region.text.trim()),
    )
    if (requireIndex < 0) continue
    const sourceRegions: PdfPageRegion[] = []
    let expectedMarker = 1
    let previousBottom = caption.box.y + caption.box.height
    let terminal = false
    for (const region of candidates.slice(requireIndex)) {
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
      if (expectedMarker >= 4 && algorithmTerminalLine(region.text)) {
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
  return (
    left.line.box.page - right.line.box.page ||
    left.line.box.y - right.line.box.y ||
    left.line.box.x - right.line.box.x ||
    left.line.id.localeCompare(right.line.id)
  )
}

function orderedSourceLines(regions: PdfPageRegion[]) {
  return regions
    .filter(
      (region) =>
        region.lines.length > 0 &&
        !['header', 'footer', 'page-number'].includes(region.kind),
    )
    .flatMap((region) =>
      region.lines
        .filter((line) => line.text.trim())
        .map((line) => ({ region, line })),
    )
    .sort(sourceLineOrder)
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

function exactSingleRunMonospacedLine(line: PdfPageRegion['lines'][number]) {
  const runs = substantiveSourceRuns(line)
  return (
    runs.length === 1 &&
    MONOSPACED_SOURCE_FONT.test(runs[0].fontName) &&
    runs[0].text === line.text &&
    !line.text.includes('\uFFFD')
  )
}

function sourceCodeSyntax(value: string) {
  const text = value.trim()
  return (
    /^(?:GET|POST|PUT|PATCH|DELETE)\s+\S/iu.test(text) ||
    /^\{[\w.-]+\}$/u.test(text) ||
    /^["']\s*[\w.-]+\s*["']\s*:/u.test(text) ||
    /^(?:def|class|function|const|let|var|return|import|from)\b/iu.test(text) ||
    /^(?:#|\/|\{|\[|\}|\])/u.test(text) ||
    /(?:=>|:=|\\n|<\/?[A-Za-z][^>]*>)/u.test(text) ||
    /^\d{1,3}[.)]\s+\S/u.test(text)
  )
}

function sourceCodeSyntaxCount(lines: PreformattedLineOwner[]) {
  return lines.filter(({ line }) => sourceCodeSyntax(line.text)).length
}

function sourceLineRecord({
  region,
  line,
}: PreformattedLineOwner): PdfPreformattedSourceLine {
  return {
    text: line.text,
    sourceRegionId: region.id,
    sourceLineId: line.id,
    sourceBox: normalizedLineageBox(line.box),
    sourceRunBoxes: substantiveSourceRuns(line).map((run) =>
      normalizedLineageBox(run),
    ),
  }
}

function exactPreformattedSource(
  lines: PreformattedLineOwner[],
  allowTranscriptProof: boolean,
): PdfPreformattedSource {
  const ordered = [...lines].sort(sourceLineOrder)
  const stablePageIndent = [
    ...new Set(ordered.map(({ line }) => line.box.page)),
  ].every((page) => {
    const pageLines = ordered.filter(({ line }) => line.box.page === page)
    const baseline = pageLines[0]?.line.box.x
    return (
      baseline !== undefined &&
      pageLines.every(({ line }) => Math.abs(line.box.x - baseline) <= 0.002)
    )
  })
  const proved =
    allowTranscriptProof &&
    ordered.length > 0 &&
    stablePageIndent &&
    ordered.every(({ line }) => exactSingleRunMonospacedLine(line))
  return {
    status: proved ? 'proved' : 'unresolved',
    lines: proved ? ordered.map(sourceLineRecord) : [],
    evidence: proved
      ? [
          'deterministic-source-line-order',
          'exact-single-run-line-text',
          'source-line-breaks-preserved',
          'zero-derived-indentation',
        ]
      : ['deterministic-source-line-order', 'source-text-exactness-unresolved'],
  }
}

function preformattedSegments(
  sourceLines: PreformattedLineOwner[],
  sourceObjects: PdfNativeObject[] = [],
) {
  const pages = [...new Set(sourceLines.map(({ line }) => line.box.page))].sort(
    (left, right) => left - right,
  )
  return pages.map<BoundedPreformattedSegment>((page) => {
    const pageLines = sourceLines
      .filter(({ line }) => line.box.page === page)
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
    const sourceBoxes = [lineBox, ...pageObjects.map((object) => object.box)]
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

function explicitPreformattedBlocks(
  regions: PdfPageRegion[],
  claimedLineIds: Set<string>,
  claimedCaptionRegionIds: Set<string>,
) {
  const ordered = orderedSourceLines(regions)
  const blocks: BoundedPreformattedBlock[] = []
  for (let anchorIndex = 0; anchorIndex < ordered.length; anchorIndex += 1) {
    const anchor = ordered[anchorIndex]
    if (
      claimedLineIds.has(anchor.line.id) ||
      claimedCaptionRegionIds.has(anchor.region.id) ||
      monospacedSourceLine(anchor.line) ||
      !/\b(?:prompt|source\s+code|code\s+block|request\s+template)\b[^.!?]*:\s*$/iu.test(
        anchor.line.text.trim(),
      )
    ) {
      continue
    }
    const sourceLines: PreformattedLineOwner[] = []
    let previous = anchor
    for (const candidate of ordered.slice(anchorIndex + 1)) {
      if (claimedLineIds.has(candidate.line.id)) break
      const samePage = candidate.line.box.page === previous.line.box.page
      const nextPage =
        candidate.line.box.page === previous.line.box.page + 1 &&
        previous.line.box.y >= 0.55 &&
        candidate.line.box.y <= 0.2
      if (!samePage && !nextPage) break
      if (
        samePage &&
        candidate.line.box.y -
          (previous.line.box.y + previous.line.box.height) >
          0.08
      ) {
        break
      }
      if (!monospacedSourceLine(candidate.line)) break
      sourceLines.push(candidate)
      previous = candidate
    }
    if (
      sourceLines.length < 3 ||
      sourceCodeSyntaxCount(sourceLines) < 2 ||
      sourceLines[0].region !== anchor.region
    ) {
      continue
    }
    const sourceLineIds = new Set(sourceLines.map(({ line }) => line.id))
    if (!retainedCaptionText(anchor.region, sourceLineIds)) continue
    const preformatted = exactPreformattedSource(sourceLines, true)
    blocks.push({
      caption: anchor.region,
      label: `Code block p${String(anchor.region.page).padStart(3, '0')}-${String(
        blocks.filter((block) => block.caption.page === anchor.region.page)
          .length + 1,
      ).padStart(3, '0')}`,
      sourceLines,
      segments: preformattedSegments(sourceLines),
      preformatted,
      evidence: [
        'source-preformatted-block',
        'explicit-preformatted-introducer',
        ...preformatted.evidence,
      ],
      captionFallbackLineId: null,
    })
    claimedCaptionRegionIds.add(anchor.region.id)
    for (const { line } of sourceLines) claimedLineIds.add(line.id)
  }
  return blocks
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
    const sourceLines = sourceRegions
      .flatMap((region) => region.lines.map((line) => ({ region, line })))
      .sort(sourceLineOrder)
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
    if (
      panelLines.length < 3 ||
      monospacedCount < 1 ||
      sourceCodeSyntaxCount(panelLines) < 2
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
) {
  const claimedLineIds = new Set<string>()
  const claimedCaptionRegionIds = new Set<string>()
  const blocks = [
    ...programListingBlocks(regions, claimedLineIds, claimedCaptionRegionIds),
    ...explicitPreformattedBlocks(
      regions,
      claimedLineIds,
      claimedCaptionRegionIds,
    ),
    ...vectorPanelPreformattedBlocks(
      pages,
      regions,
      claimedLineIds,
      claimedCaptionRegionIds,
    ),
  ]
  return blocks.sort((left, right) => {
    const leftLine = left.sourceLines[0]
    const rightLine = right.sourceLines[0]
    return leftLine && rightLine
      ? sourceLineOrder(leftLine, rightLine)
      : left.label.localeCompare(right.label)
  })
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
  if (
    nativeObjectCount < MIN_COMPOSITE_FIGURE_FRAGMENTS ||
    overlayBoxes.length < MIN_CAPTION_BOUNDED_FLOW_OVERLAY_LINE_COUNT ||
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
      ),
    ),
  )
  const bottom = rounded(
    Math.min(
      candidate.renderBox.y + candidate.renderBox.height,
      captionBox.y - CAPTION_BOUNDED_PANEL_BOTTOM_INSET,
    ),
  )
  const topCandidates = [
    ...new Set(
      [
        ...(malformedTrimmedEnvelope ? [candidate.renderBox.y] : []),
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
          (malformedTrimmedEnvelope
            ? top >= candidate.renderBox!.y
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
        ownedSourceBoxes.length < MIN_CAPTION_BOUNDED_FLOW_OVERLAY_LINE_COUNT
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
  const proseCue =
    /\b(?:the|this|that|these|those|we|our|for|with|from|where|which|using|use|used|each|value|model|models|result|results|example|examples|figure|table|equation|performance|activating|because|namely|allowing|represents|output|number|sharp|discontinuity|simple|optimizer|epochs|trained|gains|point|moving)\b/iu.test(
      text,
    )
  if (proseCue && proseWords.length >= 2) return false
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
    line.runs.some((run) => /CMEX\d*/iu.test(run.fontName) && run.text.trim()),
  )
}

export function isProbableDisplayEquation(region: PdfPageRegion) {
  return (
    region.kind === 'equation' &&
    region.lines.length > 0 &&
    (probableDisplayEquationText(region.text) ||
      hasMathExtensionFontProvenance(region) ||
      unresolvedMathExtensionRegion(region) ||
      hasAmbiguousStackedEquationGeometry([region]))
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

function sourcePrintedEquationNumber(region: PdfPageRegion) {
  const text = region.text.replace(/\s+/gu, ' ').trim()
  const fragment = text.match(/^\(\s*(\d+[a-z]?)\s*\)$/iu)?.[1]
  if (fragment) return fragment

  const terminal = /(?:[,;]\s*|\s+)\(\s*(\d+[a-z]?)\s*\)$/iu.exec(text)
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
    // PDF font metrics can place neighboring fragments from the same display
    // on slightly staggered baselines. Keep this diagonal bridge narrow so it
    // joins split formula runs without swallowing a separate display line.
    (gap.horizontal <= 0.025 && gap.vertical <= 0.012)
  )
}

function unpublishableEquationTranscriptText(text: string) {
  return text.includes('\ufffd') || sanitizeXmlText(text) !== text
}

function unresolvedMathExtensionRun(
  run: PdfPageRegion['lines'][number]['runs'][number],
) {
  return (
    /CMEX\d*/iu.test(run.fontName) &&
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
    /CMEX\d*/iu.test(run.fontName) &&
    (unresolvedMathExtensionRun(run) || /^[A-Za-z]$/u.test(run.text))
  )
}

function mathExtensionGlyphFragment(region: PdfPageRegion) {
  const runs = region.lines.flatMap((line) => line.runs)
  return runs.length > 0 && runs.every((run) => /CMEX\d*/iu.test(run.fontName))
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

function computerModernMathFont(fontName: string) {
  return /(?:^|[+_-])(?:CMMI|CMR|CMSY)\d*(?:$|[+_-])/iu.test(fontName)
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
      computerModernMathFont(run.fontName) &&
      run.fontSize <= maximumFontSize * 0.82 &&
      Math.abs(run.y + run.height / 2 - baselineCenter) > threshold,
  )
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

function computerModernMathGlyphFont(fontName: string) {
  return /(?:^|[+_-])(?:CMMI|CMSY|CMEX|MSAM|MSBM)\d*(?:$|[+_-])/iu.test(
    fontName,
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
    runs.length > 0 &&
    runs.every(
      (run) =>
        computerModernMathFont(run.fontName) ||
        computerModernMathGlyphFont(run.fontName),
    )
  )
}

function sourceMathFragment(region: PdfPageRegion) {
  const text = region.text.replace(/\s+/gu, ' ').trim()
  if (
    !text ||
    Array.from(text).length > 40 ||
    region.lines.length === 0 ||
    region.lines.length > 2 ||
    region.box.width > 0.28 ||
    region.box.height > 0.06
  ) {
    return false
  }
  const proseWords = text.match(/[A-Za-z]{4,}/gu) ?? []
  if (
    proseWords.some(
      (word) =>
        !/^(?:arg|cosh?|diag|exp|log|max|min|sinh?|sqrt|tanh?|var)$/iu.test(
          word,
        ),
    )
  ) {
    return false
  }
  const runs = region.lines
    .flatMap((line) => line.runs)
    .filter((run) => run.text.trim())
  const sourceCharacterCount = runs.reduce(
    (total, run) => total + Array.from(run.text.replace(/\s+/gu, '')).length,
    0,
  )
  if (sourceCharacterCount === 0) return false
  const mathCharacterCount = runs
    .filter((run) => computerModernMathGlyphFont(run.fontName))
    .reduce(
      (total, run) => total + Array.from(run.text.replace(/\s+/gu, '')).length,
      0,
    )
  const mathFontRatio = mathCharacterCount / sourceCharacterCount
  const sourceScriptGeometry = region.lines.some(lineHasSourceScriptGeometry)
  const hasMathToken =
    /[\p{Script=Greek}\p{N}_′″=+\-−×÷≤≥≈∼⊙∂∞∏∈∉→←]/u.test(text) ||
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
      mathFontRatio >= 0.8)
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
    .filter((run) => !computerModernMathFont(run.fontName))
    .map((run) => run.text)
    .join('')
  if (
    !sourceText ||
    sourceText.length > 240 ||
    !sourceCharactersComplete ||
    runs.filter((run) => computerModernMathFont(run.fontName)).length < 3 ||
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
        unresolvedMathExtensionGlyphFragment(candidate) ||
        !hasDisplayEquationEvidence(candidate, regions) ||
        !preservesPrintedEquationCardinality(
          displayRegions,
          candidate,
          regions,
        ) ||
        !displayRegions.some((region) =>
          adjacentDisplayEquationRegion(region, candidate),
        )
      ) {
        continue
      }
      const combined = unionBox([...displayRegions, candidate])
      if (
        combined.height > 0.12 ||
        combined.width > MAX_DISPLAY_EQUATION_WIDTH
      ) {
        continue
      }
      displayRegions.push(candidate)
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
  const uniquelyOwnedByDisplay = (candidate: PdfPageRegion) => {
    const ownedDistance = Math.min(
      ...displayRegions.map((region) => displayDistance(region, candidate)),
    )
    const competingDistances = regions
      .filter(
        (region) =>
          region.id !== candidate.id &&
          region.page === candidate.page &&
          !consumedRegionIds.has(region.id) &&
          region.kind === 'equation' &&
          hasDisplayEquationEvidence(region, regions) &&
          !displayRegions.some((display) => display.id === region.id),
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
      const sourceMathGlyphFragment = sourceMathFragment(candidate)
      const numericAssignmentFragment = numericListAssignmentFragment(candidate)
      const attachableFragmentKind =
        ['body', 'spanning', 'side', 'chart-label', 'page-number'].includes(
          candidate.kind,
        ) || candidate.kind === 'equation'
      if (
        attachedRegionIds.has(candidate.id) ||
        candidate.page !== source.page ||
        consumedRegionIds.has(candidate.id) ||
        !attachableFragmentKind
      ) {
        continue
      }
      let fragment: PdfPageRegion | null = null
      if (
        mathExtensionFragment ||
        sourceMathGlyphFragment ||
        numericAssignmentFragment
      ) {
        fragment = candidate
      } else {
        const selectedMathLines = candidate.lines.filter((line) => {
          const lineFragment = {
            ...candidate,
            text: line.text,
            box: line.box,
            lines: [line],
          }
          return (
            mathExtensionGlyphFragment(lineFragment) ||
            sourceMathFragment(lineFragment) ||
            numericListAssignmentFragment(lineFragment)
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
      const ownedRegions = [...displayRegions, ...attachedFragments]
      const displayScope = {
        ...source,
        box: unionBox(ownedRegions),
      }
      const sourceOwnedFragment =
        fragment !== null &&
        insideDisplayEnvelope(fragment, ownedRegions) &&
        uniquelyOwnedByDisplay(fragment)
      const compactFragment = compactEquationFragment(candidate)
      const gap = boxGap(displayScope.box, candidate.box)
      const adjacentCompactFragment =
        compactFragment &&
        (alignedPrintedEquationNumber(displayScope, candidate) ||
          ownedRegions.some((region) => {
            const regionGap = boxGap(region.box, candidate.box)
            return regionGap.horizontal <= 0.01 && regionGap.vertical <= 0.012
          }) ||
          (gap.horizontal <= 0.01 && gap.vertical <= 0.012))
      const selected = sourceOwnedFragment
        ? fragment
        : adjacentCompactFragment
          ? candidate
          : null
      if (
        !selected ||
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
  if (sourceLineIdSet.size !== sourceLineIds.length) return false
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
    (!hasAmbiguousStackedEquationGeometry([...sources]) ||
      inlineSiblingRegions.some((region) => region.kind !== 'body'))
  ) {
    return false
  }
  const sourceRunOwnershipKeys = sources.flatMap((source) =>
    source.lines.flatMap((line) =>
      line.runs
        .filter((run) => run.text.trim())
        .map((run) =>
          [
            run.page,
            rounded(run.x),
            rounded(run.y),
            rounded(run.width),
            rounded(run.height),
            run.rotation,
            run.text,
            run.fontName,
            rounded(run.fontSize),
          ].join('\u001f'),
        ),
    ),
  )
  if (new Set(sourceRunOwnershipKeys).size !== sourceRunOwnershipKeys.length) {
    return false
  }
  const lineOccurrenceCount = new Map<string, number>()
  const runOccurrenceCount = new Map<string, number>()
  for (const region of regions) {
    for (const line of region.lines) {
      lineOccurrenceCount.set(
        line.id,
        (lineOccurrenceCount.get(line.id) ?? 0) + 1,
      )
      for (const run of line.runs.filter((candidate) =>
        candidate.text.trim(),
      )) {
        const key = [
          run.page,
          rounded(run.x),
          rounded(run.y),
          rounded(run.width),
          rounded(run.height),
          run.rotation,
          run.text,
          run.fontName,
          rounded(run.fontSize),
        ].join('\u001f')
        runOccurrenceCount.set(key, (runOccurrenceCount.get(key) ?? 0) + 1)
      }
    }
  }
  if (
    sourceLineIds.some((lineId) => lineOccurrenceCount.get(lineId) !== 1) ||
    sourceRunOwnershipKeys.some((key) => runOccurrenceCount.get(key) !== 1)
  ) {
    return false
  }
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
    const sourceMathGlyphFragment = sourceMathFragment(candidate)
    const numericAssignmentFragment = numericListAssignmentFragment(candidate)
    const formulaFragment =
      (candidate.kind === 'equation' &&
        hasDisplayEquationEvidence(candidate, regions)) ||
      mathExtensionFragment ||
      sourceMathGlyphFragment ||
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
        adjacentDisplayEquationRegion(source, candidate),
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
  const decorativeObjectIds = decorativeNativeObjectIds(pages)
  const pageBackdropObjectIds = reusedPageBackdropObjectIds(pages)
  const panelClipObjectIds = reusedPanelClipObjectIds(pages)
  // Region classification is part of the caption evidence. Looking only at the
  // leading text turns sentences such as "Table 5 shows ..." into invented
  // visual relationships when they occur at the start of a paragraph.
  const captionLabels = new Map(
    regions.flatMap((region) => {
      const label = parsePdfScholarlyVisualLabel(region.text, {
        context: 'caption',
      })
      return label ? ([[region, label]] as const) : []
    }),
  )
  const preformattedBlocks = boundedPreformattedBlocks(pages, regions)
  const preformattedCaptionRegionIds = new Set(
    preformattedBlocks.map((block) => block.caption.id),
  )
  const captions = regions.filter(
    (region) =>
      region.kind === 'caption' &&
      captionLabels.has(region) &&
      !preformattedCaptionRegionIds.has(region.id) &&
      !unstyledProseTableReference(region),
  )
  const figureCaptions = captions.filter(
    (caption) => captionLabels.get(caption)?.kind === 'figure',
  )
  const figures = figureCandidates(
    regions,
    figureCaptions,
    decorativeObjectIds,
    pageBackdropObjectIds,
    panelClipObjectIds,
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
    let candidates = figures.filter(
      (candidate) => candidate.kind === label.kind,
    )
    if (label.kind === 'table' || label.kind === 'equation') {
      const availableTableRegions = availableRegionsForTable(
        regions,
        consumedRegionIds,
        consumedLineIds,
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
            pages.find((page) => page.page === caption.page)?.objects ?? [],
        })
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
          semanticTableGrid = detectHierarchicalTableWithinProvenScope(
            availableTableRegions,
            boundedScope.scope,
          )
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
            : boundedScope.status === 'matched' || detectedTable === null
              ? boundedScope
              : null
      }
      const nearbySources = nextSourceRegions(caption, regions, label.kind)
      const selectedSources =
        label.kind === 'table'
          ? (semanticTableGrid?.sourceRegions ??
            detectedTable?.sourceRegions ??
            [])
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
            ...(label.kind === 'table'
              ? {
                  evidence: visualAsset
                    ? [
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
    const boundedCropBaseBox =
      best?.renderBox ??
      (best?.kind === 'table' && best.sourceBoxes.length === 1
        ? { ...best.sourceBoxes[0] }
        : null)
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
        boundedCropBaseBox &&
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
        boundedCropBaseBox
      ) {
        const selectedTableLineIds = new Set(
          best.sourceLineIds ??
            best.sourceRegionIds.flatMap(
              (sourceRegionId) =>
                regions
                  .find((region) => region.id === sourceRegionId)
                  ?.lines.map((line) => line.id) ?? [],
            ),
        )
        const attemptedBoxes = [compositeSourceBox, boundedCropBaseBox]
        retryTableCrop: for (const neighborGapFraction of TABLE_SOURCE_CROP_NEIGHBOR_GAP_FRACTIONS) {
          for (const padding of TABLE_SOURCE_CROP_RETRY_PADDINGS) {
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
                if (
                  neighborGapFraction >
                  TABLE_SOURCE_CROP_NEIGHBOR_GAP_FRACTIONS[0]
                ) {
                  result.best!.evidence.push(
                    'source-page-crop-adaptive-neighbor-gap',
                  )
                }
                result.best!.evidence.push('source-page-crop-neighbor-bounded')
                break retryTableCrop
              }
              if (!retryTouchedEdge) break retryTableCrop
            }
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
      result.matched &&
      best?.kind === 'figure' &&
      rasterizeFigure &&
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
    const ownsUnresolvedBoundedTableText =
      status === 'unresolved' &&
      label.kind === 'table' &&
      result.matched &&
      Boolean(matchedCandidate?.tableRegionLineage?.length) &&
      matchedCandidate!.tableRegionLineage!.every(
        (lineage) => lineage.lineIds.length > 0,
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
    const unresolvedOverlayRegionIds =
      status === 'unresolved' &&
      label.kind === 'figure' &&
      result.matched &&
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
    if (
      ownsUnresolvedBoundedTableText &&
      result.best &&
      !result.best.evidence.includes('unresolved-bounded-table-text-owned')
    ) {
      result.best.evidence.push('unresolved-bounded-table-text-owned')
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
              consumedRegionIds.add(sourceRegionId)
            }
          }
        }
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
    } else if (ownsUnresolvedBoundedTableText) {
      // A complete bounded source scope remains review-required when no
      // publication-safe rendition can be produced. Its cell stream still
      // belongs to that unresolved table, not to the surrounding prose.
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
      sourceRegionIds:
        status === 'matched'
          ? best!.sourceRegionIds
          : unresolvedBoundedTableRegionIds,
      sourceLineIds:
        status === 'matched'
          ? [...(best!.sourceLineIds ?? [])]
          : unresolvedBoundedTableLineIds,
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
          : ownsUnresolvedBoundedTableText
            ? [caption.box, ...matchedCandidate!.sourceBoxes]
            : [caption.box],
      sourceText:
        status === 'matched'
          ? best!.sourceText
          : ownsUnresolvedBoundedTableText
            ? matchedCandidate!.sourceText
            : ownsUnresolvedFigureText
              ? matchedCandidate!.sourceText
              : '',
      altText: caption.text,
      altTextSource: 'caption',
      canonicalNodeId: null,
      captionNodeId: null,
    })
  }

  const preformattedCountByPage = new Map<number, number>()
  for (const block of preformattedBlocks) {
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
      semanticKind: 'code',
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
  for (const algorithm of boundedAlgorithmBlocks(regions, consumedRegionIds)) {
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
    for (const region of algorithm.sourceRegions) {
      consumedRegionIds.add(region.id)
      for (const line of region.lines) consumedLineIds.add(line.id)
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
        message: `${algorithm.label} has a proved bounded source panel, but no exact source crop is available; its numbered lines were withheld from canonical prose.`,
        sourceBoxes: [algorithm.caption.box, algorithm.sourceBox],
        target: {
          regionIds: algorithm.sourceRegions.map((region) => region.id),
          markerId: null,
        },
      })
    }
  }

  const equationCountByPage = new Map<number, number>()
  const examinedEquationRegionIds = new Set<string>()
  for (const source of regions.filter(
    (region) =>
      !consumedRegionIds.has(region.id) &&
      hasDisplayEquationEvidence(region, regions),
  )) {
    if (
      consumedRegionIds.has(source.id) ||
      examinedEquationRegionIds.has(source.id)
    ) {
      continue
    }
    if (
      unresolvedMathExtensionGlyphFragment(source) &&
      regions.some(
        (candidate) =>
          candidate.id !== source.id &&
          candidate.page === source.page &&
          !consumedRegionIds.has(candidate.id) &&
          candidate.kind === 'equation' &&
          probableDisplayEquationText(candidate.text) &&
          attachedEquationRegions(candidate, regions, consumedRegionIds).some(
            (attached) => attached.id === source.id,
          ),
      )
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
    const sourceScopeComplete = completeEquationSourceScope(
      sources,
      regions,
      consumedRegionIds,
      examinedEquationRegionIds,
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
      ...transcriptEvidence,
      ...(!sourceScopeComplete ? ['incomplete-equation-source-scope'] : []),
      ...(visualAsset ? ['readable-text-svg-approximation'] : []),
    ]
    const unboundedInitialCropBox = paddedUnionBox([sourceBox])
    const sourceEquationLineIds = new Set(
      sources.flatMap((region) => region.lines.map((line) => line.id)),
    )
    const ownedSourceBoxes = sources.flatMap((region) =>
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
    )
    const overlappingUnownedSourceText = hasOverlappingUnownedEquationText(
      ownedSourceBoxes,
      sourceEquationLineIds,
      regions,
    )
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
    let neighborBoundedCrop = !sameSourceBox(
      sourceCropBox,
      unboundedInitialCropBox,
    )
    if (
      rasterizeFigure &&
      sourceScopeComplete &&
      !overlappingUnownedSourceText
    ) {
      cropVetoedUnownedText = hasUnownedSourceTextInEquationCrop(
        sourceCropBox,
        sourceEquationLineIds,
        regions,
      )
      if (!cropVetoedUnownedText) {
        sourceCrop = await rasterizeFigure({
          kind: 'equation',
          page: source.page,
          sourceBox: sourceCropBox,
          sourceObjectIds: [sourceObjectId],
          sourceBoxes: [sourceBox],
          ownedSourceBoxes,
        }).catch((error: unknown) => {
          cropTouchedEdge = sourcePageCropTouchesEdge(error)
          return null
        })
      }
      const attemptedBoxes = [sourceCropBox]
      retryEquationCrop: for (const padding of EQUATION_SOURCE_CROP_RETRY_PADDINGS) {
        if (sourceCrop || !cropTouchedEdge) break
        const retryBoxes = neighborBoundedCropBoxes(
          sourceBox,
          sourceEquationLineIds,
          regions,
          padding,
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
          if (
            hasUnownedSourceTextInEquationCrop(
              retryBox,
              sourceEquationLineIds,
              regions,
            )
          ) {
            cropVetoedUnownedText = true
            continue
          }
          let retryTouchedEdge = false
          const retryCrop = await rasterizeFigure({
            kind: 'equation',
            page: source.page,
            sourceBox: retryBox,
            sourceObjectIds: [sourceObjectId],
            sourceBoxes: [sourceBox],
            ownedSourceBoxes,
          }).catch((error: unknown) => {
            retryTouchedEdge = sourcePageCropTouchesEdge(error)
            return null
          })
          cropTouchedEdge = retryTouchedEdge
          if (retryCrop) {
            sourceCropBox = retryBox
            sourceCrop = retryCrop
            adaptivePaddingRetry = true
            neighborBoundedCrop = true
            break retryEquationCrop
          }
          if (!retryTouchedEdge) break retryEquationCrop
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
      ),
    )
    if (sourceCrop && cropMatched) mergeAsset(assetStore, sourceCrop)
    const evidence = cropMatched
      ? [
          'source-equation-region',
          'bounded-source-geometry',
          ...transcriptEvidence,
          ...(adaptivePaddingRetry
            ? ['source-page-crop-adaptive-padding']
            : []),
          ...(neighborBoundedCrop ? ['source-page-crop-neighbor-bounded'] : []),
          'source-page-crop',
        ]
      : approximationEvidence
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
    relationships.push({
      id: '',
      kind: 'equation',
      label,
      // Keep the primary equation region in reading order so layout can turn
      // its source text into the accessible caption for a matched crop.
      captionRegionId: source.id,
      sourceRegionIds: cropMatched ? sources.map((region) => region.id) : [],
      sourceLineIds: cropMatched
        ? sources.flatMap((region) => region.lines.map((line) => line.id))
        : [],
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
            : cropVetoedUnownedText
              ? `${label} has unowned source text inside the required rectangular crop, so no contaminated rendition was retained.`
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
  }
}
