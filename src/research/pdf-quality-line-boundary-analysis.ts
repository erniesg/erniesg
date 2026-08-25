import type {
  NodeSourceEvidence,
  PdfLineBoundaryDecision,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfVisualAsset,
  PdfVisualRelationship,
} from './import-types'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import type { ResearchPaper } from './schema'

export function classifyStructuralLineBoundaryDecisions({
  decisions,
  paper,
  provenance,
  visualRelationships,
  assets,
  regions,
  pages,
}: {
  decisions: PdfLineBoundaryDecision[]
  paper: ResearchPaper
  provenance?: Record<string, NodeSourceEvidence>
  visualRelationships?: PdfVisualRelationship[]
  assets?: PdfVisualAsset[]
  regions?: readonly PdfPageRegion[]
  pages?: readonly PdfPageAnalysis[]
}) {
  const validatedRelationships = validatedPdfVisualRelationships({
    paper,
    provenance,
    relationships: visualRelationships,
    assets,
    regions,
    pages,
  })
  const validatedRelationshipIds = new Set(
    validatedRelationships.map((relationship) => relationship.id),
  )
  const selectedVisualLineIdsByRegion = new Map<string, Set<string>>()
  for (const relationship of visualRelationships ?? []) {
    if (
      !validatedRelationshipIds.has(relationship.id) ||
      !relationship.sourceLineIds?.length
    ) {
      continue
    }
    for (const regionId of relationship.sourceRegionIds) {
      const selected =
        selectedVisualLineIdsByRegion.get(regionId) ?? new Set<string>()
      for (const lineId of relationship.sourceLineIds) selected.add(lineId)
      selectedVisualLineIdsByRegion.set(regionId, selected)
    }
  }
  const relationshipOwnersByRegion = new Map<string, PdfVisualRelationship[]>()
  for (const relationship of visualRelationships ?? []) {
    for (const regionId of relationship.sourceRegionIds) {
      const owners = relationshipOwnersByRegion.get(regionId) ?? []
      owners.push(relationship)
      relationshipOwnersByRegion.set(regionId, owners)
    }
  }
  const renderedTextRegionIds = new Set<string>()
  for (const node of paper.nodes) {
    if (!('text' in node)) continue
    for (const regionId of provenance?.[node.id]?.regionIds ?? []) {
      renderedTextRegionIds.add(regionId)
    }
  }
  const strictVisualOnlyRegionIds = new Set(
    [...relationshipOwnersByRegion]
      .filter(
        ([regionId, owners]) =>
          owners.length === 1 &&
          validatedRelationshipIds.has(owners[0].id) &&
          !renderedTextRegionIds.has(regionId),
      )
      .map(([regionId]) => regionId),
  )
  const classified = decisions.map((decision) => {
    if (
      decision.outcome !== 'unresolved' &&
      decision.outcome !== 'ambiguous' &&
      decision.outcome !== 'structural-boundary'
    ) {
      return decision
    }
    const isStrictVisualOnly = strictVisualOnlyRegionIds.has(decision.regionId)
    const selectedLineIds = selectedVisualLineIdsByRegion.get(decision.regionId)
    const isSourceLineVisualBoundary = Boolean(
      selectedLineIds?.has(decision.fromLineId) ||
      selectedLineIds?.has(decision.toLineId),
    )
    const isStructural = isStrictVisualOnly || isSourceLineVisualBoundary
    const structuralEvidence = isStrictVisualOnly
      ? 'strict-visual-only-region'
      : 'source-line-visual-boundary'
    const retainedEvidence = decision.evidence.filter(
      (evidence) =>
        evidence !== 'strict-visual-only-region' &&
        evidence !== 'source-line-visual-boundary',
    )
    return {
      ...decision,
      outcome: isStructural
        ? ('structural-boundary' as const)
        : decision.outcome === 'structural-boundary'
          ? ('unresolved' as const)
          : decision.outcome,
      evidence: isStructural
        ? [...new Set([...retainedEvidence, structuralEvidence])]
        : retainedEvidence,
    }
  })
  return {
    decisions: classified,
    unresolvedCorruptingJoinCount: classified.filter(
      (decision) =>
        decision.outcome === 'unresolved' || decision.outcome === 'ambiguous',
    ).length,
    structurallyConsumedLineBoundaryCount: classified.filter(
      (decision) => decision.outcome === 'structural-boundary',
    ).length,
  }
}

export function validateLineBoundaryLedger(
  regions: PdfPageRegion[] | undefined,
  decisions: PdfLineBoundaryDecision[] | undefined,
  reportedUnresolvedCount: number | undefined,
  reportedStructurallyConsumedCount: number | undefined,
) {
  if (!decisions) {
    return {
      configured: false,
      valid: true,
      expected: 0,
      decided: 0,
      unresolved: reportedUnresolvedCount ?? 0,
      structurallyConsumed: reportedStructurallyConsumedCount ?? 0,
    }
  }
  const expectedTransitions = new Set<string>()
  for (const region of regions ?? []) {
    for (let index = 0; index < region.lines.length - 1; index += 1) {
      expectedTransitions.add(
        `${region.id}:${region.lines[index].id}:${region.lines[index + 1].id}`,
      )
    }
  }
  const ids = new Set<string>()
  const transitions = new Set<string>()
  let structurallyValid = Boolean(regions)
  for (const decision of decisions) {
    const transition = `${decision.regionId}:${decision.fromLineId}:${decision.toLineId}`
    const region = regions?.find(
      (candidate) => candidate.id === decision.regionId,
    )
    if (
      ids.has(decision.id) ||
      transitions.has(transition) ||
      !expectedTransitions.has(transition) ||
      region?.page !== decision.page
    ) {
      structurallyValid = false
    }
    ids.add(decision.id)
    transitions.add(transition)
  }
  const unresolved = decisions.filter(
    (decision) =>
      decision.outcome === 'unresolved' || decision.outcome === 'ambiguous',
  ).length
  const structurallyConsumed = decisions.filter(
    (decision) => decision.outcome === 'structural-boundary',
  ).length
  const expected = expectedTransitions.size
  const valid =
    structurallyValid &&
    decisions.length === expected &&
    transitions.size === expected &&
    [...expectedTransitions].every((transition) =>
      transitions.has(transition),
    ) &&
    (reportedUnresolvedCount === undefined ||
      reportedUnresolvedCount === unresolved) &&
    (reportedStructurallyConsumedCount === undefined ||
      reportedStructurallyConsumedCount === structurallyConsumed)
  return {
    configured: true,
    valid,
    expected,
    decided: decisions.length,
    unresolved,
    structurallyConsumed,
  }
}
