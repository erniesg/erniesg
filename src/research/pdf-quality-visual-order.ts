import type {
  PdfReadingOrderGraph,
  PdfVisualRelationship,
} from './import-types'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'
import type { ResearchPaper } from './schema'

export function canonicalVisualOrderViolationRelationshipIds(
  paper: ResearchPaper,
  relationships: readonly PdfVisualRelationship[],
  readingOrder: PdfReadingOrderGraph | undefined,
) {
  if (!readingOrder || relationships.length < 2) return []
  const nodeOrder = new Map(
    paper.nodes.map((node, index) => [node.id, index] as const),
  )
  const regionOrder = new Map(
    readingOrder.order.map((regionId, index) => [regionId, index] as const),
  )
  const positioned = relationships.flatMap((relationship) => {
    if (
      relationship.status !== 'matched' ||
      relationship.canonicalNodeId === null ||
      relationship.captionNodeId === null
    ) {
      return []
    }
    const visualIndex = nodeOrder.get(relationship.canonicalNodeId)
    const captionIndex = nodeOrder.get(relationship.captionNodeId)
    const sourceRanks = [
      regionOrder.get(relationship.captionRegionId),
      ...relationship.sourceRegionIds.map((regionId) =>
        regionOrder.get(regionId),
      ),
    ].filter((rank): rank is number => rank !== undefined)
    if (
      visualIndex === undefined ||
      captionIndex !== visualIndex + 1 ||
      sourceRanks.length === 0
    ) {
      return []
    }
    return [
      {
        relationship,
        sourceRank: Math.min(...sourceRanks),
        visualIndex,
        parsedLabel: parsePdfScholarlyVisualLabel(relationship.label, {
          context: 'caption',
        }),
      },
    ]
  })
  if (positioned.length < 2) return []

  const implicated = new Set<string>()
  const positionedByKind = new Map<
    PdfVisualRelationship['kind'],
    typeof positioned
  >()
  for (const candidate of positioned) {
    const values = positionedByKind.get(candidate.relationship.kind) ?? []
    values.push(candidate)
    positionedByKind.set(candidate.relationship.kind, values)
  }
  for (const sameKind of positionedByKind.values()) {
    sameKind.sort((left, right) => {
      const leftOrdinal =
        left.parsedLabel?.status === 'parsed' &&
        /^\d+$/u.test(left.parsedLabel.identifier)
          ? Number(left.parsedLabel.identifier)
          : null
      const rightOrdinal =
        right.parsedLabel?.status === 'parsed' &&
        /^\d+$/u.test(right.parsedLabel.identifier)
          ? Number(right.parsedLabel.identifier)
          : null
      if (
        leftOrdinal !== null &&
        rightOrdinal !== null &&
        leftOrdinal !== rightOrdinal
      ) {
        return leftOrdinal - rightOrdinal
      }
      return (
        left.sourceRank - right.sourceRank ||
        left.relationship.id.localeCompare(right.relationship.id)
      )
    })
    let previous = sameKind[0]
    for (const current of sameKind.slice(1)) {
      // A shared source rank does not prove an ordering constraint.
      if (current.sourceRank === previous.sourceRank) {
        if (current.visualIndex > previous.visualIndex) previous = current
        continue
      }
      if (current.visualIndex < previous.visualIndex) {
        implicated.add(previous.relationship.id)
        implicated.add(current.relationship.id)
        continue
      }
      previous = current
    }
  }
  return [...implicated]
}
