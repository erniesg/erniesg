import type {
  NormalizedSourceBox,
  PdfLineBoundaryDecision,
  PdfLinkAnnotation,
  PdfLinkSourceAnchor,
  PdfLinkSourceAnchorFragment,
  PdfPageRegion,
  ReconstructionDiagnostic,
} from './import-types'
import { exactCanonicalRangeForSource } from './pdf-canonical-source-anchors'
import {
  normalizedPdfExternalLinkTarget,
  resolvePdfExternalLinkSourceIntervalOwnership,
  resolvePdfInternalLinkAnnotation,
  resolvePdfLinkedTokenRangeContinuity,
  safePdfExternalLinkTarget,
  type PdfCanonicalInternalLinkTarget,
} from './pdf-links'
import { replayPdfRegionLineRanges } from './pdf-lines'
import { literalAbsoluteHyperlinks } from './pdf-source-inline-evidence'
import {
  exactSourceRunRanges,
  normalizedInlineSourceText,
  type ExactSourceRunRange,
} from './pdf-source-run-ranges'
import { boxesOverlap } from './pdf-visual-source-mapping'

type PdfCanonicalHyperlinkBlock = {
  region: PdfPageRegion
  text: string
  nodeId?: string
  sourceSegments?: Array<{
    region: PdfPageRegion
    sourceStart: number
    canonicalStart: number
    text: string
  }>
}

type HyperlinkMappingLedger = { expected: number; mapped: number }

type CanonicalHyperlinkMapping = {
  annotationId: string
  blockNodeId: string
  start: number
  end: number
  href: string
}

export type CanonicalHyperlinkOccurrence = {
  annotationId: string
  url: string
}

export type CanonicalInternalHyperlinkSurface = {
  targetNodeId: string
  blockNodeId: string
  start: number
  end: number
  sourceBoxes: NormalizedSourceBox[]
}

function blockSourceSegments(block: PdfCanonicalHyperlinkBlock) {
  return (
    block.sourceSegments ?? [
      {
        region: block.region,
        sourceStart: 0,
        canonicalStart: 0,
        text: block.text,
      },
    ]
  )
}

function sourceAnchorSegments(blocks: readonly PdfCanonicalHyperlinkBlock[]) {
  return [
    ...new Map(
      blocks
        .flatMap((block) => blockSourceSegments(block))
        .map(
          (segment) =>
            [
              `${segment.region.id}\0${segment.sourceStart}\0${segment.text.length}\0${segment.text}`,
              segment,
            ] as const,
        ),
    ).values(),
  ]
}

function exactLinkSourceAnchorFragments({
  annotation,
  segments,
  sourceRangesByRegionId,
}: {
  annotation: PdfLinkAnnotation
  segments: ReturnType<typeof sourceAnchorSegments>
  sourceRangesByRegionId: ReadonlyMap<
    string,
    ReturnType<typeof exactSourceRunRanges>
  >
}) {
  if (!annotation.box) return []
  const sourceRangeOwnerId = (
    regionId: string,
    sourceRange: ExactSourceRunRange,
  ) =>
    `${regionId}\0${sourceRange.line.id}\0${sourceRange.line.runs.indexOf(sourceRange.run)}\0${sourceRange.sourceStart}\0${sourceRange.sourceEnd}`
  const externalIntervalOwnership =
    annotation.status === 'external'
      ? resolvePdfExternalLinkSourceIntervalOwnership({
          annotation,
          candidates: [
            ...new Map(
              segments.flatMap((segment) =>
                (sourceRangesByRegionId.get(segment.region.id) ?? [])
                  .filter((sourceRange) =>
                    boxesOverlap(annotation.box, sourceRange.run),
                  )
                  .map((sourceRange) => {
                    const ownerId = sourceRangeOwnerId(
                      segment.region.id,
                      sourceRange,
                    )
                    return [
                      ownerId,
                      {
                        ownerId,
                        sourceStart: sourceRange.sourceStart,
                        sourceEnd: sourceRange.sourceEnd,
                        text: normalizedInlineSourceText(sourceRange.run.text),
                        sourceBox: sourceRange.run,
                      },
                    ] as const
                  }),
              ),
            ).values(),
          ],
        })
      : null
  const fragments: PdfLinkSourceAnchorFragment[] = []
  for (const segment of segments) {
    const sourceRanges = sourceRangesByRegionId.get(segment.region.id) ?? []
    const segmentEnd = segment.sourceStart + segment.text.length
    for (const sourceRange of sourceRanges) {
      if (!boxesOverlap(annotation.box, sourceRange.run)) continue
      const sourceOwnership =
        externalIntervalOwnership?.ownerId ===
        sourceRangeOwnerId(segment.region.id, sourceRange)
          ? externalIntervalOwnership
          : null
      // Once one target-specific source interval has unique ownership, a
      // merely overlapping neighboring run is not another fragment of that
      // link. Retaining it would make every canonical block fail the exact
      // range check even though the target surface proved one owner.
      if (externalIntervalOwnership && !sourceOwnership) continue
      const sourceStart = Math.max(
        sourceOwnership?.sourceStart ?? sourceRange.sourceStart,
        segment.sourceStart,
      )
      const sourceEnd = Math.min(
        sourceOwnership?.sourceEnd ?? sourceRange.sourceEnd,
        segmentEnd,
      )
      if (sourceStart >= sourceEnd) continue
      const segmentOffset = sourceStart - segment.sourceStart
      const text = segment.text.slice(
        segmentOffset,
        segmentOffset + sourceEnd - sourceStart,
      )
      if (!text || segment.region.text.slice(sourceStart, sourceEnd) !== text) {
        continue
      }
      const runIndex = sourceRange.line.runs.indexOf(sourceRange.run)
      if (runIndex < 0) continue
      fragments.push({
        regionId: segment.region.id,
        lineId: sourceRange.line.id,
        runIndex,
        sourceSequenceIndex: sourceRange.run.sourceSequenceIndex ?? null,
        sourceStart,
        sourceEnd,
        text,
        ...(sourceOwnership
          ? { ownershipEvidence: sourceOwnership.evidence }
          : {}),
        sourceBox: sourceOwnership
          ? { ...sourceOwnership.sourceBox }
          : {
              page: sourceRange.run.page,
              x: sourceRange.run.x,
              y: sourceRange.run.y,
              width: sourceRange.run.width,
              height: sourceRange.run.height,
              rotation: sourceRange.run.rotation,
              method: sourceRange.run.method,
            },
      })
    }
  }
  return [
    ...new Map(
      fragments.map(
        (fragment) =>
          [
            `${fragment.regionId}\0${fragment.lineId}\0${fragment.runIndex}\0${fragment.sourceStart}\0${fragment.sourceEnd}`,
            fragment,
          ] as const,
      ),
    ).values(),
  ].sort(
    (left, right) =>
      left.sourceBox.page - right.sourceBox.page ||
      left.sourceBox.y - right.sourceBox.y ||
      left.sourceBox.x - right.sourceBox.x ||
      left.regionId.localeCompare(right.regionId) ||
      left.sourceStart - right.sourceStart,
  )
}

export function buildPdfLinkSourceAnchorLedger({
  blocks,
  annotations,
  lineBoundaryDecisions = [],
}: {
  blocks: readonly PdfCanonicalHyperlinkBlock[]
  annotations: readonly PdfLinkAnnotation[]
  lineBoundaryDecisions?: readonly PdfLineBoundaryDecision[]
}): PdfLinkSourceAnchor[] {
  const segments = sourceAnchorSegments(blocks)
  const sourceRangesByRegionId = new Map<
    string,
    ReturnType<typeof exactSourceRunRanges>
  >()
  const segmentsByPage = new Map<number, typeof segments>()
  for (const segment of segments) {
    if (!sourceRangesByRegionId.has(segment.region.id)) {
      sourceRangesByRegionId.set(
        segment.region.id,
        exactSourceRunRanges(segment.region, lineBoundaryDecisions),
      )
    }
    const pageSegments = segmentsByPage.get(segment.region.page) ?? []
    pageSegments.push(segment)
    segmentsByPage.set(segment.region.page, pageSegments)
  }
  return annotations.map((annotation) => {
    const fragments = exactLinkSourceAnchorFragments({
      annotation,
      segments: segmentsByPage.get(annotation.page) ?? [],
      sourceRangesByRegionId,
    })
    return {
      annotationId: annotation.id,
      page: annotation.page,
      status: fragments.length > 0 ? 'anchored' : 'unresolved',
      fragments,
      evidence: 'exact-source-run-interval-v1',
    }
  })
}

function escapedRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function exactInternalLinkSurfacePattern(
  target:
    { kind: PdfCanonicalInternalLinkTarget['kind']; label: string } | undefined,
) {
  if (!target) return null
  const prefixByKind = {
    section: 'Section',
    appendix: 'Appendix',
    figure: 'Figure',
    table: 'Table',
    equation: 'Equation',
    reference: 'Reference',
    note: '(?:Footnote|Endnote)',
  } as const
  const prefix = prefixByKind[target.kind]
  const identifier = target.label.match(
    new RegExp(`^(?:${prefix})\\s+(.+)$`, 'iu'),
  )?.[1]
  if (!identifier) return null
  const exactIdentifier = escapedRegularExpression(identifier)
  const surface =
    target.kind === 'section'
      ? `(?:§\\s*|Sections?\\s+|Secs?\\.?\\s*)${exactIdentifier}`
      : target.kind === 'figure'
        ? `(?:Figures?\\s+|Figs?\\.?\\s*)${exactIdentifier}`
        : target.kind === 'table'
          ? `(?:Tables?\\s+|Tabs?\\.?\\s*)${exactIdentifier}`
          : target.kind === 'equation'
            ? `(?:Equations?\\s+|Eqs?\\.?\\s*)\\(?${exactIdentifier}\\)?`
            : target.kind === 'appendix'
              ? `Appendix\\s+${exactIdentifier}`
              : target.kind === 'note'
                ? `(?:Footnotes?|Endnotes?)\\s+${exactIdentifier}`
                : null
  return surface
    ? new RegExp(`(?<![\\p{L}\\p{N}])${surface}(?![\\p{L}\\p{N}])`, 'giu')
    : null
}

function exactInternalLinkSurfaceRanges(
  block: PdfCanonicalHyperlinkBlock,
  annotation: { box: NormalizedSourceBox },
  target:
    { kind: PdfCanonicalInternalLinkTarget['kind']; label: string } | undefined,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  const pattern = exactInternalLinkSurfacePattern(target)
  if (!pattern) return []
  const ranges: Array<{ start: number; end: number }> = []
  for (const segment of blockSourceSegments(block)) {
    const replay = replayPdfRegionLineRanges(
      segment.region,
      lineBoundaryDecisions,
    )
    if (replay?.text !== segment.region.text) continue
    for (const line of segment.region.lines) {
      if (!line.runs.some((run) => boxesOverlap(annotation.box, run))) continue
      const lineRange = replay.ranges.get(line.id)
      if (!lineRange) continue
      for (const match of line.text.matchAll(pattern)) {
        if (match.index === undefined || !match[0]) continue
        const range = exactCanonicalRangeForSource(
          block,
          segment.region.id,
          lineRange.start + match.index,
          lineRange.start + match.index + match[0].length,
        )
        if (range) ranges.push(range)
      }
    }
  }
  return [
    ...new Map(
      ranges.map((range) => [`${range.start}:${range.end}`, range] as const),
    ).values(),
  ]
}

function canonicalHyperlinkRange(
  block: PdfCanonicalHyperlinkBlock,
  annotation: Exclude<PdfLinkAnnotation, { status: 'unresolved' }>,
  sourceAnchor: PdfLinkSourceAnchor,
  target:
    { kind: PdfCanonicalInternalLinkTarget['kind']; label: string } | undefined,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  const exactTargetSurfaces = exactInternalLinkSurfaceRanges(
    block,
    annotation,
    target,
    lineBoundaryDecisions,
  )
  if (exactTargetSurfaces.length === 1) return exactTargetSurfaces[0]
  if (exactTargetSurfaces.length > 1) return null
  if (target?.kind === 'reference' || target?.kind === 'note') return null

  const ranges = sourceAnchor.fragments.map((fragment) =>
    exactCanonicalRangeForSource(
      block,
      fragment.regionId,
      fragment.sourceStart,
      fragment.sourceEnd,
    ),
  )
  if (ranges.some((range) => range === null)) return null
  const ordered = [
    ...new Map(
      ranges.map((range) => [`${range!.start}:${range!.end}`, range!] as const),
    ).values(),
  ].sort((left, right) => left.start - right.start || left.end - right.end)
  if (ordered.length === 0) return null
  for (let index = 1; index < ordered.length; index += 1) {
    const prior = ordered[index - 1]
    const current = ordered[index]
    if (
      current.start > prior.end &&
      block.text.slice(prior.end, current.start).trim()
    ) {
      return null
    }
  }
  const start = ordered[0].start
  const end = Math.max(...ordered.map((range) => range.end))
  const substantiallyNarrowerThanSourceRun = sourceAnchor.fragments.some(
    (fragment) => annotation.box.width < fragment.sourceBox.width * 0.8,
  )
  if (substantiallyNarrowerThanSourceRun) {
    const exactLiteralExternalRanges =
      annotation.status === 'external'
        ? literalAbsoluteHyperlinks(block.text).filter(
            (candidate) =>
              normalizedPdfExternalLinkTarget(candidate.url) ===
                normalizedPdfExternalLinkTarget(annotation.url) &&
              candidate.start >= start &&
              candidate.end <= end,
          )
        : []
    if (exactLiteralExternalRanges.length === 1) {
      return {
        start: exactLiteralExternalRanges[0].start,
        end: exactLiteralExternalRanges[0].end,
      }
    }
    return null
  }
  return start < end ? { start, end } : null
}

function hasStrongCanonicalSurfaceOwnership(
  annotationBox: NormalizedSourceBox,
  surfaceBox: NormalizedSourceBox,
) {
  if (
    annotationBox.rotation !== surfaceBox.rotation ||
    !boxesOverlap(annotationBox, surfaceBox)
  ) {
    return false
  }
  const overlapWidth =
    Math.min(
      annotationBox.x + annotationBox.width,
      surfaceBox.x + surfaceBox.width,
    ) - Math.max(annotationBox.x, surfaceBox.x)
  const overlapHeight =
    Math.min(
      annotationBox.y + annotationBox.height,
      surfaceBox.y + surfaceBox.height,
    ) - Math.max(annotationBox.y, surfaceBox.y)
  const annotationArea = annotationBox.width * annotationBox.height
  const surfaceArea = surfaceBox.width * surfaceBox.height
  const overlapArea = overlapWidth * overlapHeight
  const horizontalCoverage =
    overlapWidth / Math.min(annotationBox.width, surfaceBox.width)
  const verticalCoverage =
    overlapHeight / Math.min(annotationBox.height, surfaceBox.height)
  // Link rectangles are sometimes shifted toward the delimiter between
  // adjacent citation labels. Permit bounded drift only when a candidate
  // still owns substantial overlap on both axes; the caller retains the
  // unique-target and unique-surface requirements.
  if (
    annotationArea <= 0 ||
    surfaceArea <= 0 ||
    overlapArea / Math.min(annotationArea, surfaceArea) < 0.25
  ) {
    return false
  }
  const annotationCenter = {
    x: annotationBox.x + annotationBox.width / 2,
    y: annotationBox.y + annotationBox.height / 2,
  }
  const surfaceCenter = {
    x: surfaceBox.x + surfaceBox.width / 2,
    y: surfaceBox.y + surfaceBox.height / 2,
  }
  const contains = (
    box: NormalizedSourceBox,
    point: { x: number; y: number },
  ) =>
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  return (
    contains(surfaceBox, annotationCenter) ||
    contains(annotationBox, surfaceCenter) ||
    (horizontalCoverage >= 0.35 && verticalCoverage >= 0.5)
  )
}

function exactCanonicalInternalHyperlinkSurfaceRange({
  annotationBox,
  block,
  surfaces,
  targetNodeId,
}: {
  annotationBox: NormalizedSourceBox
  block: PdfCanonicalHyperlinkBlock
  surfaces: readonly CanonicalInternalHyperlinkSurface[]
  targetNodeId: string
}) {
  if (!block.nodeId) return null
  const candidates = [
    ...new Map(
      surfaces
        .filter(
          (surface) =>
            surface.blockNodeId === block.nodeId &&
            surface.sourceBoxes.some((box) =>
              hasStrongCanonicalSurfaceOwnership(annotationBox, box),
            ) &&
            surface.start >= 0 &&
            surface.start < surface.end &&
            surface.end <= block.text.length,
        )
        .map(
          (surface) =>
            [
              `${surface.targetNodeId}:${surface.blockNodeId}:${surface.start}:${surface.end}`,
              surface,
            ] as const,
        ),
    ).values(),
  ]
  if (candidates.length !== 1 || candidates[0].targetNodeId !== targetNodeId) {
    return null
  }
  return { start: candidates[0].start, end: candidates[0].end }
}

export function resolveCanonicalHyperlinkObligations({
  blocks,
  annotations,
  canonicalOccurrences = [],
  canonicalTargets = [],
  canonicalInternalSurfaces = [],
  lineBoundaryDecisions = [],
}: {
  blocks: PdfCanonicalHyperlinkBlock[]
  annotations: PdfLinkAnnotation[]
  canonicalOccurrences?: CanonicalHyperlinkOccurrence[]
  canonicalTargets?: PdfCanonicalInternalLinkTarget[]
  canonicalInternalSurfaces?: CanonicalInternalHyperlinkSurface[]
  lineBoundaryDecisions?: readonly PdfLineBoundaryDecision[]
}) {
  const mappings: CanonicalHyperlinkMapping[] = []
  const diagnostics: ReconstructionDiagnostic[] = []
  const approvedAnnotationIds = new Set<string>()
  const pendingInternalClaims: Array<{
    annotation: PdfLinkAnnotation
    sourceAnchor: PdfLinkSourceAnchor
    mapping: CanonicalHyperlinkMapping
  }> = []
  let mappedAnnotationCount = 0
  const blocksBySourceRegionId = new Map<string, PdfCanonicalHyperlinkBlock[]>()
  const blocksByNodeId = new Map(
    blocks.flatMap((block) =>
      block.nodeId ? [[block.nodeId, block] as const] : [],
    ),
  )
  for (const block of blocks) {
    const sourceRegionIds = new Set(
      blockSourceSegments(block).map((segment) => segment.region.id),
    )
    for (const regionId of sourceRegionIds) {
      const regionBlocks = blocksBySourceRegionId.get(regionId) ?? []
      regionBlocks.push(block)
      blocksBySourceRegionId.set(regionId, regionBlocks)
    }
  }
  const sourceAnchorLedger = buildPdfLinkSourceAnchorLedger({
    blocks,
    annotations,
    lineBoundaryDecisions,
  })
  const sourceAnchorsByAnnotationId = new Map(
    sourceAnchorLedger.map((anchor) => [anchor.annotationId, anchor] as const),
  )
  const recordFailure = (
    annotation: PdfLinkAnnotation,
    sourceAnchor: PdfLinkSourceAnchor,
    failure: string,
  ) => {
    const regionIds = [
      ...new Set(sourceAnchor.fragments.map((fragment) => fragment.regionId)),
    ]
    diagnostics.push({
      code: 'UNRESOLVED_HYPERLINK',
      severity: 'error',
      page: annotation.page,
      message: failure,
      ...(annotation.box ? { sourceBoxes: [annotation.box] } : {}),
      relationshipId: annotation.id,
      ...(regionIds.length > 0
        ? {
            target: {
              regionIds,
              markerId: annotation.id,
            },
          }
        : {}),
    })
  }
  for (const annotation of annotations) {
    const sourceAnchor = sourceAnchorsByAnnotationId.get(annotation.id)!
    let failure: string | null = null
    if (annotation.status === 'unresolved') {
      failure = `PDF link annotation ${annotation.id} remains unresolved (${annotation.reason})${annotation.target ? ` for ${annotation.target}` : ''}.`
    } else {
      const destinationResolution =
        annotation.status === 'internal'
          ? resolvePdfInternalLinkAnnotation(annotation, canonicalTargets)
          : null
      const parsedDestination =
        destinationResolution && 'parsed' in destinationResolution
          ? destinationResolution.parsed
          : undefined
      const resolvedCanonicalSurfaceTargets =
        destinationResolution?.status === 'matched'
          ? [
              ...new Map(
                canonicalTargets
                  .filter(
                    (target) =>
                      target.nodeId === destinationResolution.targetNodeId &&
                      (!parsedDestination ||
                        target.kind === parsedDestination.kind),
                  )
                  .map(
                    (target) =>
                      [`${target.kind}:${target.label}`, target] as const,
                  ),
              ).values(),
            ]
          : []
      const sourceSurfaceTarget =
        resolvedCanonicalSurfaceTargets.length === 1
          ? resolvedCanonicalSurfaceTargets[0]
          : parsedDestination
      const isCanonicalSurfaceDestination =
        destinationResolution?.status === 'matched' &&
        (sourceSurfaceTarget?.kind === 'reference' ||
          canonicalTargets.some(
            (target) =>
              target.nodeId === destinationResolution.targetNodeId &&
              target.kind === 'reference',
          ) ||
          ((sourceSurfaceTarget?.kind === 'note' ||
            canonicalTargets.some(
              (target) =>
                target.nodeId === destinationResolution.targetNodeId &&
                target.kind === 'note',
            )) &&
            canonicalInternalSurfaces.some(
              (surface) =>
                surface.targetNodeId === destinationResolution.targetNodeId,
            )))
      const sourceOwnedBlocks = [
        ...new Set(
          sourceAnchor.fragments.flatMap(
            (fragment) => blocksBySourceRegionId.get(fragment.regionId) ?? [],
          ),
        ),
      ]
      const canonicalSurfaceBlocks = isCanonicalSurfaceDestination
        ? [
            ...new Set(
              canonicalInternalSurfaces.flatMap((surface) =>
                surface.sourceBoxes.some((box) =>
                  hasStrongCanonicalSurfaceOwnership(annotation.box, box),
                )
                  ? [blocksByNodeId.get(surface.blockNodeId)]
                  : [],
              ),
            ),
          ].filter((block): block is PdfCanonicalHyperlinkBlock =>
            Boolean(block),
          )
        : []
      const annotationBlocks = [
        ...new Set([...sourceOwnedBlocks, ...canonicalSurfaceBlocks]),
      ]
      const candidates = annotationBlocks.flatMap((block) => {
        if (!block.nodeId) return []
        const range = isCanonicalSurfaceDestination
          ? exactCanonicalInternalHyperlinkSurfaceRange({
              annotationBox: annotation.box,
              block,
              surfaces: canonicalInternalSurfaces,
              targetNodeId: destinationResolution.targetNodeId,
            })
          : canonicalHyperlinkRange(
              block,
              annotation,
              sourceAnchor,
              sourceSurfaceTarget,
              lineBoundaryDecisions,
            )
        return range
          ? [
              {
                annotationId: annotation.id,
                blockNodeId: block.nodeId,
                ...range,
              },
            ]
          : []
      })
      if (annotation.status === 'internal') {
        if (!destinationResolution) {
          throw new Error('missing internal PDF destination resolution')
        }
        if (destinationResolution.status === 'unsupported') {
          failure = `Internal PDF destination ${annotation.destination} uses an unsupported internal PDF destination scheme.`
        } else if (destinationResolution.status === 'missing') {
          failure = `Internal PDF destination ${annotation.destination} has no exact canonical target.`
        } else if (destinationResolution.status === 'ambiguous') {
          failure = `Internal PDF destination ${annotation.destination} maps to more than one canonical target.`
        } else if (candidates.length !== 1) {
          failure =
            candidates.length === 0
              ? `PDF link annotation ${annotation.id} has no exact canonical inline owner.`
              : `PDF link annotation ${annotation.id} maps to ${candidates.length} canonical inline owners.`
        } else {
          const href = `#${destinationResolution.targetNodeId}`
          pendingInternalClaims.push({
            annotation,
            sourceAnchor,
            mapping: {
              ...candidates[0],
              href,
            },
          })
        }
      } else if (!safePdfExternalLinkTarget(annotation.url)) {
        failure = `PDF link annotation ${annotation.id} has an unsafe external target.`
      } else {
        const existingOccurrences = canonicalOccurrences.filter(
          (candidate) => candidate.annotationId === annotation.id,
        )
        const candidateCount = candidates.length + existingOccurrences.length
        if (
          candidateCount === 1 &&
          existingOccurrences.every(
            (candidate) => candidate.url === annotation.url,
          )
        ) {
          mappings.push(
            ...candidates.map((candidate) => ({
              ...candidate,
              href: annotation.url,
            })),
          )
          approvedAnnotationIds.add(annotation.id)
          mappedAnnotationCount += 1
        } else {
          failure =
            candidateCount === 0
              ? `PDF link annotation ${annotation.id} has no exact canonical inline owner.`
              : `PDF link annotation ${annotation.id} maps to ${candidateCount} canonical inline owners.`
        }
      }
    }
    if (!failure) continue
    recordFailure(annotation, sourceAnchor, failure)
  }
  const internalClaimsByCanonicalRange = new Map<
    string,
    typeof pendingInternalClaims
  >()
  for (const claim of pendingInternalClaims) {
    const rangeKey = `${claim.mapping.blockNodeId}\u0000${claim.mapping.start}\u0000${claim.mapping.end}`
    const claims = internalClaimsByCanonicalRange.get(rangeKey) ?? []
    claims.push(claim)
    internalClaimsByCanonicalRange.set(rangeKey, claims)
  }
  for (const rangeKey of [...internalClaimsByCanonicalRange.keys()].sort()) {
    const claims = internalClaimsByCanonicalRange
      .get(rangeKey)!
      .sort((left, right) =>
        left.annotation.id.localeCompare(right.annotation.id),
      )
    const hrefs = [...new Set(claims.map((claim) => claim.mapping.href))].sort()
    if (hrefs.length === 1) {
      mappings.push(claims[0].mapping)
      for (const claim of claims) {
        approvedAnnotationIds.add(claim.annotation.id)
        mappedAnnotationCount += 1
      }
      continue
    }
    for (const claim of claims) {
      recordFailure(
        claim.annotation,
        claim.sourceAnchor,
        `Canonical inline owner ${claim.mapping.blockNodeId}:${claim.mapping.start}-${claim.mapping.end} has conflicting internal targets ${hrefs.join(', ')}; PDF link annotation ${claim.annotation.id} remains unresolved.`,
      )
    }
  }
  const annotationsById = new Map(
    annotations.map((annotation) => [annotation.id, annotation] as const),
  )
  const mappingsByCanonicalRange = new Map<
    string,
    Array<{ mapping: CanonicalHyperlinkMapping; index: number }>
  >()
  for (const [index, mapping] of mappings.entries()) {
    const rangeKey = `${mapping.blockNodeId}\u0000${mapping.start}\u0000${mapping.end}`
    const values = mappingsByCanonicalRange.get(rangeKey) ?? []
    values.push({ mapping, index })
    mappingsByCanonicalRange.set(rangeKey, values)
  }
  const conflictingMappingIndexes = new Set<number>()
  const conflictingMappingGroups: Array<{
    rangeKey: string
    claims: Array<{ mapping: CanonicalHyperlinkMapping; index: number }>
    hrefs: string[]
  }> = []
  for (const rangeKey of [...mappingsByCanonicalRange.keys()].sort()) {
    const claims = mappingsByCanonicalRange.get(rangeKey)!
    const hrefs = [...new Set(claims.map(({ mapping }) => mapping.href))].sort()
    if (hrefs.length <= 1) continue
    for (const { index } of claims) conflictingMappingIndexes.add(index)
    conflictingMappingGroups.push({ rangeKey, claims, hrefs })
  }
  if (conflictingMappingIndexes.size > 0) {
    mappings.splice(
      0,
      mappings.length,
      ...mappings.filter((_, index) => !conflictingMappingIndexes.has(index)),
    )
  }
  for (const { rangeKey, claims, hrefs } of conflictingMappingGroups) {
    for (const annotationId of [
      ...new Set(claims.map(({ mapping }) => mapping.annotationId)),
    ].sort()) {
      const annotation = annotationsById.get(annotationId)
      const sourceAnchor = sourceAnchorsByAnnotationId.get(annotationId)
      if (!annotation || !sourceAnchor) continue
      if (approvedAnnotationIds.delete(annotationId)) {
        mappedAnnotationCount -= 1
      }
      recordFailure(
        annotation,
        sourceAnchor,
        `Canonical inline owner ${rangeKey.replaceAll('\u0000', ':')} has conflicting hyperlink targets ${hrefs.join(', ')}; PDF link annotation ${annotationId} remains unresolved.`,
      )
    }
  }
  const externalAnnotationsById = new Map(
    annotations.flatMap((annotation) =>
      annotation.status === 'external'
        ? [[annotation.id, annotation] as const]
        : [],
    ),
  )
  for (const mapping of mappings) {
    const annotation = externalAnnotationsById.get(mapping.annotationId)
    const block = blocksByNodeId.get(mapping.blockNodeId)
    const normalizedTarget = annotation
      ? normalizedPdfExternalLinkTarget(annotation.url)
      : null
    if (!annotation || !block || !normalizedTarget) continue
    const literalCandidates = literalAbsoluteHyperlinks(block.text).filter(
      (candidate) =>
        normalizedPdfExternalLinkTarget(candidate.url) === normalizedTarget &&
        candidate.start <= mapping.end &&
        candidate.end >= mapping.start,
    )
    if (literalCandidates.length !== 1) continue
    mapping.start = literalCandidates[0].start
    mapping.end = literalCandidates[0].end
  }
  const linkedTokenRangeResolutions = resolvePdfLinkedTokenRangeContinuity({
    ownerTexts: new Map(
      blocks.flatMap((block) =>
        block.nodeId ? [[block.nodeId, block.text] as const] : [],
      ),
    ),
    ranges: mappings.flatMap((mapping) => {
      const annotation = externalAnnotationsById.get(mapping.annotationId)
      return annotation
        ? [
            {
              annotationId: mapping.annotationId,
              ownerId: mapping.blockNodeId,
              start: mapping.start,
              end: mapping.end,
              target: annotation.url,
              sourceBox: annotation.box,
            },
          ]
        : []
    }),
  })
  const mappingKey = (
    mapping: Pick<
      CanonicalHyperlinkMapping,
      'annotationId' | 'blockNodeId' | 'start' | 'end'
    >,
  ) =>
    `${mapping.annotationId}\u0000${mapping.blockNodeId}\u0000${mapping.start}\u0000${mapping.end}`
  for (const resolution of linkedTokenRangeResolutions) {
    const fragmentKeys = new Set(
      resolution.fragments.map((fragment) =>
        mappingKey({
          annotationId: fragment.annotationId,
          blockNodeId: fragment.ownerId,
          start: fragment.start,
          end: fragment.end,
        }),
      ),
    )
    const indexes = mappings.flatMap((mapping, index) =>
      fragmentKeys.has(mappingKey(mapping)) ? [index] : [],
    )
    if (resolution.status === 'unresolved') {
      for (const index of [...indexes].sort((left, right) => right - left)) {
        mappings.splice(index, 1)
      }
      for (const annotationId of resolution.annotationIds) {
        if (approvedAnnotationIds.delete(annotationId)) {
          mappedAnnotationCount -= 1
        }
      }
      diagnostics.push({
        code: 'UNRESOLVED_HYPERLINK',
        severity: 'error',
        ...(resolution.sourceBoxes[0]
          ? { page: resolution.sourceBoxes[0].page }
          : {}),
        message:
          resolution.reason === 'unproven-wrap-whitespace'
            ? `PDF link annotations ${resolution.annotationIds.join(', ')} have visible URL fragments that round-trip only after removing unproven source whitespace.`
            : `PDF link annotations ${resolution.annotationIds.join(', ')} have visible URL fragments that do not round-trip to their normalized target.`,
        ...(resolution.sourceBoxes.length > 0
          ? { sourceBoxes: resolution.sourceBoxes }
          : {}),
        relationshipId: resolution.annotationIds.join('+'),
      })
      continue
    }
    if (indexes.length !== resolution.fragments.length) continue
    const insertionIndex = Math.min(...indexes)
    for (const index of [...indexes].sort((left, right) => right - left)) {
      mappings.splice(index, 1)
    }
    mappings.splice(
      insertionIndex,
      0,
      ...resolution.fragments.map((fragment) => ({
        annotationId: fragment.annotationId,
        blockNodeId: resolution.ownerId,
        start: resolution.start,
        end: resolution.end,
        href:
          externalAnnotationsById.get(fragment.annotationId)?.url ??
          resolution.normalizedTarget,
      })),
    )
  }
  return {
    mappings,
    approvedAnnotationIds,
    diagnostics,
    sourceAnchorLedger,
    ledger: {
      expected: annotations.length,
      mapped: mappedAnnotationCount,
    } satisfies HyperlinkMappingLedger,
  }
}
