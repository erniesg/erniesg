import {
  PdfImportError,
  type NormalizedSourceBox,
  type PdfReconstruction,
  type PdfScholarlyCrossReferenceKind,
} from './import-types'
import { resolvePdfScholarlyCrossReferences } from './pdf-cross-references'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'
import type { ResearchNode, ResearchPaper } from './schema'

type CanonicalCrossReferenceOccurrence = {
  relationshipId: string | undefined
  semanticRole: string | undefined
  targetIds: string[] | undefined
  nodeId: string
  start: number
  end: number
}

function canonicalCrossReferenceOccurrences(
  paper: ResearchPaper,
): CanonicalCrossReferenceOccurrence[] {
  return paper.nodes.flatMap((node) =>
    'inlineRuns' in node
      ? (node.inlineRuns ?? []).flatMap((run) =>
          run.semanticRole === 'cross-reference' ||
          run.relationshipId?.startsWith('scholarly-cross-reference-')
            ? [
                {
                  relationshipId: run.relationshipId,
                  semanticRole: run.semanticRole,
                  targetIds: run.targetIds,
                  nodeId: node.id,
                  start: run.start,
                  end: run.end,
                },
              ]
            : [],
        )
      : [],
  )
}

function boxesOverlap(left: NormalizedSourceBox, right: NormalizedSourceBox) {
  return (
    left.page === right.page &&
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  )
}

type ExportCrossReferenceTarget = {
  kind: PdfScholarlyCrossReferenceKind
  label: string
  nodeId: string
  evidence: string[]
}

export function canonicalHeadingCrossReferenceTargets(
  paper: ResearchPaper,
): ExportCrossReferenceTarget[] {
  const headings = paper.nodes.filter(
    (node): node is Extract<ResearchNode, { type: 'heading' }> =>
      node.type === 'heading',
  )
  const plainLettered = headings.flatMap((node) => {
    const match = node.text.trim().match(/^([A-Z])\s+\p{Lu}/u)
    return match ? [{ node, ordinal: match[1].charCodeAt(0) }] : []
  })
  const sequencedPlainLetteredIds = new Set<string>()
  for (let index = 0; index < plainLettered.length - 1; index += 1) {
    if (plainLettered[index + 1].ordinal === plainLettered[index].ordinal + 1) {
      sequencedPlainLetteredIds.add(plainLettered[index].node.id)
      sequencedPlainLetteredIds.add(plainLettered[index + 1].node.id)
    }
  }
  const nestedLetteredParentLabels = new Set(
    headings.flatMap((node) => {
      const match = node.text.trim().match(/^([A-Z])\.\d+(?:\.\d+)*\.?\s+\S/u)
      return match ? [match[1]] : []
    }),
  )
  return headings.flatMap((node) => {
    const value = node.text.trim()
    const explicitAppendix = value.match(/^appendix\s+([A-Z](?:\.\d+)*)\b/iu)
    const lettered = value.match(/^([A-Z](?:\.\d+)*)\.\s+\S/u)
    const nestedLettered = value.match(/^([A-Z](?:\.\d+)+)\s+\S/u)
    const plainLetteredMatch = value.match(/^([A-Z])\s+\p{Lu}/u)
    const plainLettered =
      plainLetteredMatch &&
      (sequencedPlainLetteredIds.has(node.id) ||
        nestedLetteredParentLabels.has(plainLetteredMatch[1]))
        ? plainLetteredMatch
        : null
    const numbered = value.match(/^(\d+(?:\.\d+)*)\.?\s+\S/u)
    const appendixIdentifier =
      explicitAppendix?.[1] ??
      lettered?.[1] ??
      nestedLettered?.[1] ??
      plainLettered?.[1]
    return [
      ...(numbered
        ? [
            {
              kind: 'section' as const,
              label: `Section ${numbered[1]}`,
              nodeId: node.id,
              evidence: [
                'canonical-heading-label',
                'source-heading-typography',
              ],
            },
          ]
        : []),
      ...(appendixIdentifier
        ? [
            {
              kind: 'appendix' as const,
              label: `Appendix ${appendixIdentifier}`,
              nodeId: node.id,
              evidence: [
                'canonical-heading-label',
                'source-heading-typography',
              ],
            },
            ...(appendixIdentifier.includes('.')
              ? [
                  {
                    kind: 'section' as const,
                    label: `Section ${appendixIdentifier}`,
                    nodeId: node.id,
                    evidence: [
                      'canonical-appendix-subheading-label',
                      'source-heading-typography',
                    ],
                  },
                ]
              : []),
          ]
        : []),
    ]
  })
}

export function isSourceProvedUnresolvedPartialParentTable(
  relationship: PdfReconstruction['visualRelationships'][number],
) {
  return (
    relationship.status === 'unresolved' &&
    relationship.kind === 'table' &&
    relationship.canonicalNodeId === null &&
    Boolean(relationship.captionNodeId) &&
    relationship.assetIds.length === 0 &&
    relationship.sourceRegionIds.length > 0 &&
    (relationship.sourceLineIds?.length ?? 0) > 0 &&
    relationship.evidence.includes('partial-parent-line-selection') &&
    relationship.evidence.includes('unresolved-bounded-table-text-owned')
  )
}

function canonicalVisualCrossReferenceTargets(
  reconstruction: PdfReconstruction,
): ExportCrossReferenceTarget[] {
  return reconstruction.visualRelationships.flatMap((relationship) => {
    const parsedLabel = parsePdfScholarlyVisualLabel(relationship.label, {
      context: 'reference',
    })
    const unresolvedBoundedTableCaption =
      isSourceProvedUnresolvedPartialParentTable(relationship)
    const targetNodeId =
      relationship.status === 'matched'
        ? relationship.canonicalNodeId
        : unresolvedBoundedTableCaption
          ? relationship.captionNodeId
          : null
    if (
      !targetNodeId ||
      parsedLabel?.status !== 'parsed' ||
      parsedLabel.plural ||
      parsedLabel.kind !== relationship.kind ||
      relationship.label.slice(parsedLabel.consumedEnd).trim().length > 0
    ) {
      return []
    }
    return [
      {
        kind: relationship.kind,
        label: relationship.label,
        nodeId: targetNodeId,
        evidence: unresolvedBoundedTableCaption
          ? [
              'unresolved-bounded-table-caption-relationship',
              'source-proved-visual-label',
            ]
          : [
              'matched-canonical-visual-relationship',
              'source-proved-visual-label',
            ],
      },
    ]
  })
}

function crossReferenceSourceClaim(
  relationship: PdfReconstruction['crossReferenceRelationships'][number],
) {
  return {
    id: relationship.id,
    kind: relationship.kind,
    text: relationship.text,
    labels: relationship.labels,
    referenceRegionId: relationship.referenceRegionId,
    referenceStart: relationship.referenceStart,
    referenceEnd: relationship.referenceEnd,
    targets: relationship.targets,
    targetNodeIds: relationship.targetNodeIds,
    status: relationship.status,
    sourceBoxes: relationship.sourceBoxes,
  }
}

export function validatePdfCrossReferenceEvidence({
  reconstruction,
  paper,
}: {
  reconstruction: PdfReconstruction
  paper: ResearchPaper
}) {
  const relationships = reconstruction.crossReferenceRelationships
  const relationshipIds = relationships.map((relationship) => relationship.id)
  const duplicateRelationshipId = relationshipIds.find(
    (id, index) => relationshipIds.indexOf(id) !== index,
  )
  if (duplicateRelationshipId) {
    throw new PdfImportError(
      'INCOMPLETE_RECONSTRUCTION',
      `PDF scholarly cross-reference evidence contains duplicate relationship ${duplicateRelationshipId}.`,
    )
  }
  const occurrences = canonicalCrossReferenceOccurrences(paper)
  const relationshipIdsSet = new Set(relationshipIds)
  const orphan = occurrences.find(
    (occurrence) =>
      !occurrence.relationshipId ||
      !relationshipIdsSet.has(occurrence.relationshipId),
  )
  if (orphan) {
    throw new PdfImportError(
      'INCOMPLETE_RECONSTRUCTION',
      `PDF scholarly cross-reference canonical inline owner has no exact relationship claim.`,
    )
  }
  const canonicalAnchorKeys = new Set<string>()
  const sourceAnchorKeys = new Set<string>()
  const nodeById = new Map(paper.nodes.map((node) => [node.id, node]))
  const regionById = new Map(
    reconstruction.regions.map((region) => [region.id, region]),
  )
  const canonicalTargets = [
    ...canonicalHeadingCrossReferenceTargets(paper),
    ...canonicalVisualCrossReferenceTargets(reconstruction),
  ]
  const validTargets = new Set(
    canonicalTargets.map(
      (target) => `${target.kind}:${target.label}:${target.nodeId}`,
    ),
  )
  const sourceCrossReferenceRegionIds = new Set(
    paper.nodes.flatMap((node) =>
      (node.type === 'paragraph' && node.list?.numberingId !== 'references') ||
      node.type === 'caption' ||
      node.type === 'footnote'
        ? (reconstruction.provenance[node.id]?.regionIds ?? [])
        : [],
    ),
  )
  const visualDefinitionEndsByRegionId = new Map<string, number>()
  for (const relationship of reconstruction.visualRelationships) {
    const captionRegion = relationship.captionRegionId
      ? regionById.get(relationship.captionRegionId)
      : undefined
    if (!captionRegion) continue
    const definition = parsePdfScholarlyVisualLabel(captionRegion.text, {
      context: 'caption',
    })
    const canonical = parsePdfScholarlyVisualLabel(relationship.label, {
      context: 'reference',
    })
    if (
      definition?.status !== 'parsed' ||
      canonical?.status !== 'parsed' ||
      definition.kind !== canonical.kind ||
      definition.identifier !== canonical.identifier
    ) {
      continue
    }
    visualDefinitionEndsByRegionId.set(
      captionRegion.id,
      Math.max(
        visualDefinitionEndsByRegionId.get(captionRegion.id) ?? 0,
        definition.consumedEnd,
      ),
    )
  }
  const redetectedRelationships = resolvePdfScholarlyCrossReferences({
    regions: reconstruction.regions.flatMap((region) => {
      if (!sourceCrossReferenceRegionIds.has(region.id)) return []
      const definitionEnd = visualDefinitionEndsByRegionId.get(region.id)
      return [
        definitionEnd
          ? {
              ...region,
              text:
                region.text.slice(0, definitionEnd).replace(/\S/gu, ' ') +
                region.text.slice(definitionEnd),
            }
          : region,
      ]
    }),
    canonicalTargets,
  })
  const relationshipsById = new Map(
    relationships.map((relationship) => [relationship.id, relationship]),
  )
  const redetectedIds = new Set(
    redetectedRelationships.map((relationship) => relationship.id),
  )
  for (const redetected of redetectedRelationships) {
    const claimed = relationshipsById.get(redetected.id)
    if (!claimed) {
      throw new PdfImportError(
        'INCOMPLETE_RECONSTRUCTION',
        `PDF scholarly cross-reference ${redetected.id} is a missing source-detected relationship claim.`,
      )
    }
    if (
      redetected.status !== 'matched' ||
      JSON.stringify(crossReferenceSourceClaim(claimed)) !==
        JSON.stringify(crossReferenceSourceClaim(redetected))
    ) {
      throw new PdfImportError(
        'INCOMPLETE_RECONSTRUCTION',
        `PDF scholarly cross-reference ${redetected.id} canonical inline target or source claim is stale, unresolved, or ambiguous.`,
      )
    }
  }
  const staleExtraRelationship = relationships.find(
    (relationship) => !redetectedIds.has(relationship.id),
  )
  if (staleExtraRelationship) {
    throw new PdfImportError(
      'INCOMPLETE_RECONSTRUCTION',
      `PDF scholarly cross-reference ${staleExtraRelationship.id} has no source-detected relationship claim.`,
    )
  }
  for (const relationship of relationships) {
    if (
      relationship.status !== 'matched' ||
      !relationship.canonicalAnchor ||
      relationship.targets.length === 0 ||
      relationship.targets.some(
        (target) =>
          target.status !== 'matched' ||
          !target.targetNodeId ||
          target.candidateNodeIds.length !== 1 ||
          target.candidateNodeIds[0] !== target.targetNodeId ||
          target.kind !== relationship.kind,
      )
    ) {
      throw new PdfImportError(
        'INCOMPLETE_RECONSTRUCTION',
        `PDF scholarly cross-reference ${relationship.id} is unresolved, ambiguous, or lacks an exact canonical claim.`,
      )
    }
    const targetNodeIds = relationship.targets.map(
      (target) => target.targetNodeId!,
    )
    if (
      JSON.stringify(relationship.labels) !==
        JSON.stringify(relationship.targets.map((target) => target.label)) ||
      JSON.stringify(relationship.targetNodeIds) !==
        JSON.stringify(targetNodeIds) ||
      relationship.targets.some(
        (target) =>
          !validTargets.has(
            `${target.kind}:${target.label}:${target.targetNodeId}`,
          ),
      )
    ) {
      throw new PdfImportError(
        'INCOMPLETE_RECONSTRUCTION',
        `PDF scholarly cross-reference ${relationship.id} canonical inline target claim is stale or unsupported by a canonical source target.`,
      )
    }
    const canonicalAnchorKey = `${relationship.canonicalAnchor.nodeId}:${relationship.canonicalAnchor.start}:${relationship.canonicalAnchor.end}`
    const sourceAnchorKey = `${relationship.referenceRegionId}:${relationship.referenceStart}:${relationship.referenceEnd}`
    if (
      canonicalAnchorKeys.has(canonicalAnchorKey) ||
      sourceAnchorKeys.has(sourceAnchorKey)
    ) {
      throw new PdfImportError(
        'INCOMPLETE_RECONSTRUCTION',
        `PDF scholarly cross-reference ${relationship.id} duplicates another canonical or source claim.`,
      )
    }
    canonicalAnchorKeys.add(canonicalAnchorKey)
    sourceAnchorKeys.add(sourceAnchorKey)
    const owner = nodeById.get(relationship.canonicalAnchor.nodeId)
    const sourceRegion = regionById.get(relationship.referenceRegionId)
    const provenance =
      reconstruction.provenance[relationship.canonicalAnchor.nodeId]
    if (
      !owner ||
      !('text' in owner) ||
      relationship.canonicalAnchor.start < 0 ||
      relationship.canonicalAnchor.end <= relationship.canonicalAnchor.start ||
      owner.text.slice(
        relationship.canonicalAnchor.start,
        relationship.canonicalAnchor.end,
      ) !== relationship.text ||
      !sourceRegion ||
      relationship.referenceStart < 0 ||
      relationship.referenceEnd <= relationship.referenceStart ||
      sourceRegion.text.slice(
        relationship.referenceStart,
        relationship.referenceEnd,
      ) !== relationship.text ||
      relationship.sourceBoxes.length === 0 ||
      !provenance ||
      !provenance.regionIds.includes(relationship.referenceRegionId) ||
      !provenance.pages.includes(sourceRegion.page) ||
      relationship.sourceBoxes.some(
        (box) =>
          box.page !== sourceRegion.page ||
          !provenance.boxes.some((sourceBox) => boxesOverlap(box, sourceBox)),
      )
    ) {
      throw new PdfImportError(
        'INCOMPLETE_RECONSTRUCTION',
        `PDF scholarly cross-reference ${relationship.id} lacks exact source-region and canonical provenance.`,
      )
    }
    const owners = occurrences.filter(
      (occurrence) => occurrence.relationshipId === relationship.id,
    )
    if (owners.length !== 1) {
      throw new PdfImportError(
        'INCOMPLETE_RECONSTRUCTION',
        `PDF scholarly cross-reference ${relationship.id} must have exactly one canonical inline owner; found ${owners.length}.`,
      )
    }
    const occurrence = owners[0]
    if (
      occurrence.semanticRole !== 'cross-reference' ||
      occurrence.nodeId !== relationship.canonicalAnchor.nodeId ||
      occurrence.start !== relationship.canonicalAnchor.start ||
      occurrence.end !== relationship.canonicalAnchor.end ||
      JSON.stringify(occurrence.targetIds) !==
        JSON.stringify(relationship.targetNodeIds)
    ) {
      throw new PdfImportError(
        'INCOMPLETE_RECONSTRUCTION',
        `PDF scholarly cross-reference ${relationship.id} canonical inline owner does not match its source-proved anchor and targets.`,
      )
    }
  }
}
