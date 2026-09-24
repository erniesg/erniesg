import type {
  NormalizedSourceBox,
  PdfPageRegion,
  PdfVisualMatchCandidate,
  PdfVisualRelationship,
} from './import-types'
import type { ParsedPdfScholarlyVisualLabel } from './pdf-scholarly-label'
import type { PdfTableScope } from './pdf-table-scope'
import { sha256HexSync } from './sha256-sync'

type VisualKind = PdfVisualRelationship['kind']

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

export type VisualCandidate = {
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

export const TEXT_OVERLAY_PREFIX = 'text-overlay:'
export const FIGURE_OVERLAY_BOX_TOLERANCE = 0.004
export const SOURCE_CROP_CONTAINMENT_TOLERANCE = 0.00001
export const MIN_CROSS_COLUMN_FIGURE_SPAN = 0.65

export function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

export function horizontalBoxOverlap(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  return Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  )
}

export function horizontalOverlapRatio(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  const denominator = Math.min(left.width, right.width)
  return denominator > 0 ? horizontalBoxOverlap(left, right) / denominator : 0
}

export function compatibleCaptionLaneColumns(
  left: PdfPageRegion['column'],
  right: PdfPageRegion['column'],
) {
  return left === right || left === 'span' || right === 'span'
}

export function captionSourceLaneMatches(
  caption: PdfPageRegion,
  region: PdfPageRegion,
) {
  return captionSourceLaneMatchesBox(caption, region.box, region.column)
}

export function captionSourceLaneMatchesBox(
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

const COMPOSITE_CAPTION_LANE_EVIDENCE = [
  'connected-native-scaffold',
  'caption-bounded-native-scaffold',
  'caption-bounded-semantic-envelope',
  'caption-bounded-reused-layer-grid-scaffold',
  'headless-composite-raster',
  'headless-composite-svg',
] as const

export function compositeCandidateMayCrossCaptionLane(
  caption: PdfPageRegion,
  candidate: VisualCandidate,
) {
  if (
    candidate.kind !== 'figure' ||
    !candidate.evidence?.some((item) =>
      COMPOSITE_CAPTION_LANE_EVIDENCE.includes(
        item as (typeof COMPOSITE_CAPTION_LANE_EVIDENCE)[number],
      ),
    )
  ) {
    return false
  }
  const scope = candidate.renderBox ?? candidate.sourceBoxes[0]
  return Boolean(
    scope &&
    horizontalOverlapRatio(caption.box, scope) >= 0.35 &&
    candidate.sourceBoxes.some(
      (sourceBox) => horizontalOverlapRatio(caption.box, sourceBox) >= 0.35,
    ),
  )
}

export function captionLaneScopedRenderBox(
  caption: PdfPageRegion,
  candidate: VisualCandidate,
) {
  const lane = caption.sourceCaptionLane
  if (
    !lane ||
    !candidate.renderBox ||
    !candidate.sourceBoxes.some(
      (sourceBox) =>
        !captionSourceLaneMatchesBox(caption, sourceBox, candidate.column),
    ) ||
    !compositeCandidateMayCrossCaptionLane(caption, candidate)
  ) {
    return candidate.renderBox
  }
  const laneLeft = lane.side === 'left' ? 0 : lane.boundary
  const laneRight = lane.side === 'left' ? lane.boundary : 1
  const left = Math.max(candidate.renderBox.x, laneLeft)
  const right = Math.min(
    candidate.renderBox.x + candidate.renderBox.width,
    laneRight,
  )
  if (right <= left) return candidate.renderBox
  return {
    ...candidate.renderBox,
    x: rounded(left),
    width: rounded(right - left),
  }
}

export type SourceHorizontalBounds = { left: number; right: number }

export function captionLaneHorizontalBounds(
  caption: PdfPageRegion,
): SourceHorizontalBounds | undefined {
  const lane = caption.sourceCaptionLane
  if (!lane) return undefined
  const boundary = Math.max(0, Math.min(1, lane.boundary))
  return lane.side === 'left'
    ? { left: 0, right: boundary }
    : { left: boundary, right: 1 }
}

export function sourceBoxWithinHorizontalBounds(
  sourceBox: NormalizedSourceBox,
  horizontalBounds: SourceHorizontalBounds | undefined,
) {
  return (
    !horizontalBounds ||
    (sourceBox.x >= horizontalBounds.left - SOURCE_CROP_CONTAINMENT_TOLERANCE &&
      sourceBox.x + sourceBox.width <=
        horizontalBounds.right + SOURCE_CROP_CONTAINMENT_TOLERANCE)
  )
}

type PdfVisualCandidateLabel = Pick<
  ParsedPdfScholarlyVisualLabel,
  'kind' | 'label'
> & { sequence: string }

function candidateScore(
  caption: PdfPageRegion,
  label: PdfVisualCandidateLabel,
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
  if (
    caption.sourceCaptionLane &&
    (candidate.sourceBoxes.length === 0 ||
      (candidate.sourceBoxes.some(
        (sourceBox) =>
          !captionSourceLaneMatchesBox(caption, sourceBox, candidate.column),
      ) &&
        !compositeCandidateMayCrossCaptionLane(caption, candidate)))
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

export function matchCandidate(
  caption: PdfPageRegion,
  label: PdfVisualCandidateLabel,
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
  const provedCompositeCaptionLane = Boolean(
    best &&
    caption.sourceCaptionLane &&
    compositeCandidateMayCrossCaptionLane(caption, best.candidate),
  )
  return {
    scored,
    best,
    ambiguous,
    matched:
      Boolean(best) &&
      (best.score >= 0.72 ||
        (provedCompositeCaptionLane && best.score >= 0.7)) &&
      !ambiguous,
  }
}

type PdfVisualMatchCandidateWithOwnershipExtent = PdfVisualMatchCandidate & {
  sourceLineIds: string[]
  sourceText: string
  ownershipExtentSha256: string
}

export function matchRecord(
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
