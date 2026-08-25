import type { NormalizedSourceBox, PdfPageRegion } from './import-types'
import { detectTableNearCaption } from './pdf-table-detection'
import { canonicalTableFromLines } from './visual-assets'
import {
  type PdfTableScope,
  type PdfTableScopeResolution,
} from './pdf-table-scope'

const MAX_TABLE_HEADER_SCOPE_GAP = 0.025
const MIN_TABLE_HEADER_HORIZONTAL_COVERAGE = 0.5

export type CompleteSemanticTableScope = {
  sourceHeaderLineIds: string[]
  evidence: string[]
}

type TableScopeVisualCandidate = {
  kind: 'table'
  captionRegionId?: string
  sourceRegionIds: string[]
  sourceLineIds: string[]
  sourceObjectIds: string[]
  assetIds: string[]
  sourceBoxes: NormalizedSourceBox[]
  sourceText: string
  page: number
  column: PdfPageRegion['column']
  renderBox: NormalizedSourceBox
  textOwnershipBox?: NormalizedSourceBox
  evidence: string[]
  sourcePageCropBlockedByReadingOrderText?: boolean
  nativeEnvelopeIncomplete?: boolean
  tableRegionLineage?: PdfTableScope['regionLineage']
}

type PdfTableScopeMatchResolution = {
  scored: Array<{
    candidate: TableScopeVisualCandidate
    score: number
    evidence: string[]
  }>
  best: {
    candidate: TableScopeVisualCandidate
    score: number
    evidence: string[]
  }
  ambiguous: boolean
  matched: boolean
}

type DetectedPdfTable = NonNullable<ReturnType<typeof detectTableNearCaption>>

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
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

function tableScopeCandidate(
  scope: PdfTableScope,
  resolution: PdfTableScopeResolution,
  regions: PdfPageRegion[],
  objectAssetIds: ReadonlyMap<string, string | null>,
): TableScopeVisualCandidate {
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
  candidate: TableScopeVisualCandidate,
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

export function completeSemanticTableScope(
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

export function matchTableScopeResolution(
  resolution: PdfTableScopeResolution,
  caption: PdfPageRegion,
  regions: PdfPageRegion[],
  objectAssetIds: ReadonlyMap<string, string | null>,
): PdfTableScopeMatchResolution {
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
