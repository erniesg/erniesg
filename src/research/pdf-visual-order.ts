import type { ResearchNode } from './schema'
import type {
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfRegionColumn,
  PdfScholarlyCrossReferenceRelationship,
  ReconstructionDiagnostic,
} from './import-types'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'

const SOURCE_BOX_TOLERANCE = 0.00002

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function validNormalizedSourceBox(box: NormalizedSourceBox) {
  return (
    Number.isInteger(box.page) &&
    box.page > 0 &&
    [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.width > 0 &&
    box.height > 0 &&
    box.x + box.width <= 1 + SOURCE_BOX_TOLERANCE &&
    box.y + box.height <= 1 + SOURCE_BOX_TOLERANCE
  )
}

export function orderCanonicalVisualPairs(
  nodes: ResearchNode[],
  pairs: readonly {
    page: number
    column: PdfRegionColumn
    sourceBox?: NormalizedSourceBox
    visualNodeId: string
    captionNodeId: string
  }[],
  crossReferences: readonly PdfScholarlyCrossReferenceRelationship[] = [],
  diagnostics: ReconstructionDiagnostic[] = [],
  nodeSourceEvidence: Readonly<Record<string, NodeSourceEvidence>> = {},
) {
  const initialNodePositions = new Map(
    nodes.map((node, index) => [node.id, index] as const),
  )
  const initialNodesById = new Map(
    nodes.map((node) => [node.id, node] as const),
  )
  const comparePairSourceOrder = (
    left: (typeof pairs)[number],
    right: (typeof pairs)[number],
  ) => {
    const sourceColumnRank = (pair: (typeof pairs)[number]) =>
      pair.column === 'right' ? 1 : pair.column === 'left' ? 0 : -1
    return (
      left.page - right.page ||
      sourceColumnRank(left) - sourceColumnRank(right) ||
      (left.sourceBox?.y ?? Number.MAX_SAFE_INTEGER) -
        (right.sourceBox?.y ?? Number.MAX_SAFE_INTEGER) ||
      (left.sourceBox?.x ?? Number.MAX_SAFE_INTEGER) -
        (right.sourceBox?.x ?? Number.MAX_SAFE_INTEGER) ||
      (initialNodePositions.get(left.captionNodeId) ??
        Number.MAX_SAFE_INTEGER) -
        (initialNodePositions.get(right.captionNodeId) ??
          Number.MAX_SAFE_INTEGER) ||
      left.captionNodeId.localeCompare(right.captionNodeId)
    )
  }
  const integerLabelForPair = (pair: (typeof pairs)[number]) => {
    const caption = initialNodesById.get(pair.captionNodeId)
    if (caption?.type !== 'caption') return null
    const parsed = parsePdfScholarlyVisualLabel(caption.text, {
      context: 'caption',
    })
    if (parsed?.status !== 'parsed' || !/^\d+$/u.test(parsed.identifier)) {
      return null
    }
    return {
      kind: parsed.kind,
      ordinal: Number(parsed.identifier),
    }
  }
  const comparePairScopedOrder = (
    left: (typeof pairs)[number],
    right: (typeof pairs)[number],
  ) => {
    const leftLabel = integerLabelForPair(left)
    const rightLabel = integerLabelForPair(right)
    if (
      leftLabel &&
      rightLabel &&
      leftLabel.kind === rightLabel.kind &&
      leftLabel.ordinal !== rightLabel.ordinal
    ) {
      return leftLabel.ordinal - rightLabel.ordinal
    }
    return comparePairSourceOrder(left, right)
  }
  const sourceOrderedPairs = [...pairs]
    .filter(
      (pair) =>
        initialNodePositions.has(pair.visualNodeId) &&
        initialNodePositions.has(pair.captionNodeId),
    )
    .sort(comparePairScopedOrder)
  const physicallySourceOrderedPairs = [...sourceOrderedPairs].sort(
    comparePairSourceOrder,
  )
  const sourceRankByVisualNodeId = new Map(
    sourceOrderedPairs.map(
      (pair, index) => [pair.visualNodeId, index] as const,
    ),
  )
  const pairByVisualNodeId = new Map(
    sourceOrderedPairs.map((pair) => [pair.visualNodeId, pair] as const),
  )
  const physicalRankByVisualNodeId = new Map(
    physicallySourceOrderedPairs.map(
      (pair, index) => [pair.visualNodeId, index] as const,
    ),
  )
  const preservesAtomicSourcePairOrder = () => {
    let previousRank = -1
    let encountered = 0
    for (const [nodeIndex, node] of nodes.entries()) {
      const sourceRank = sourceRankByVisualNodeId.get(node.id)
      if (sourceRank === undefined) continue
      const pair = pairByVisualNodeId.get(node.id)
      if (
        !pair ||
        nodes[nodeIndex + 1]?.id !== pair.captionNodeId ||
        sourceRank <= previousRank
      ) {
        return false
      }
      previousRank = sourceRank
      encountered += 1
    }
    return encountered === sourceOrderedPairs.length
  }
  const preservesAtomicPhysicalSourcePairOrder = () => {
    let previousRank = -1
    let encountered = 0
    for (const [nodeIndex, node] of nodes.entries()) {
      const sourceRank = physicalRankByVisualNodeId.get(node.id)
      if (sourceRank === undefined) continue
      const pair = pairByVisualNodeId.get(node.id)
      if (
        !pair ||
        nodes[nodeIndex + 1]?.id !== pair.captionNodeId ||
        sourceRank <= previousRank
      ) {
        return false
      }
      previousRank = sourceRank
      encountered += 1
    }
    return encountered === physicallySourceOrderedPairs.length
  }
  const restoreNodes = (snapshot: readonly ResearchNode[]) => {
    nodes.splice(0, nodes.length, ...snapshot)
  }
  const recordSourceOrderFloatFallback = ({
    page,
    visualNodeId,
    reason,
    relationshipId,
    sourceBoxes = [],
    target,
  }: {
    page: number
    visualNodeId: string
    reason: string
    relationshipId?: string
    sourceBoxes?: NormalizedSourceBox[]
    target?: ReconstructionDiagnostic['target']
  }) => {
    if (preservesAtomicPhysicalSourcePairOrder()) {
      diagnostics.push({
        code: 'SOURCE_ORDER_FLOAT_FALLBACK',
        severity: 'info',
        page,
        message: `Skipped optional placement for canonical visual ${visualNodeId}; ${reason} The source-proved atomic visual-caption order remains unchanged.`,
        ...(relationshipId ? { relationshipId } : {}),
        sourceBoxes,
        ...(target ? { target } : {}),
      })
      return
    }
    diagnostics.push({
      code: 'AMBIGUOUS_READING_ORDER',
      severity: 'error',
      page,
      message: `Canonical visual ${visualNodeId} cannot use the source-order float fallback because the source-proved atomic visual-caption order is not intact.`,
      ...(relationshipId ? { relationshipId } : {}),
      sourceBoxes,
      ...(target ? { target } : {}),
    })
  }
  const pairsByPage = new Map<number, typeof pairs>()
  for (const pair of pairs) {
    const pagePairs = pairsByPage.get(pair.page) ?? []
    pairsByPage.set(pair.page, [...pagePairs, pair])
  }

  for (const pagePairs of pairsByPage.values()) {
    const sourcePositions = new Map(
      nodes.map((node, index) => [node.id, index] as const),
    )
    const pairNodeIds = new Set(
      pagePairs.flatMap(({ visualNodeId, captionNodeId }) => [
        visualNodeId,
        captionNodeId,
      ]),
    )
    const pairSlots = nodes.flatMap((node, index) =>
      pairNodeIds.has(node.id) ? [index] : [],
    )
    const pairsAreContiguous =
      pairSlots.length > 0 &&
      pairSlots.at(-1)! - pairSlots[0] + 1 === pairSlots.length
    const hasProvenColumnFlow =
      pagePairs.every(
        (pair) => pair.column === 'left' || pair.column === 'right',
      ) &&
      pagePairs.some((pair) => pair.column === 'left') &&
      pagePairs.some((pair) => pair.column === 'right')
    const pagePairLabels = pagePairs.map(integerLabelForPair)
    const hasProvedIntegerLabelOrder =
      pagePairs.every(
        (pair) =>
          pair.sourceBox !== undefined &&
          validNormalizedSourceBox(pair.sourceBox),
      ) &&
      pagePairLabels.every(
        (label): label is NonNullable<typeof label> => label !== null,
      ) &&
      new Set(pagePairLabels.map((label) => label.kind)).size === 1
    const orderedPairs =
      hasProvenColumnFlow || hasProvedIntegerLabelOrder
        ? [...pagePairs].sort(comparePairScopedOrder)
        : !pairsAreContiguous
          ? [...pagePairs].sort(
              (left, right) =>
                (sourcePositions.get(left.captionNodeId) ??
                  Number.MAX_SAFE_INTEGER) -
                  (sourcePositions.get(right.captionNodeId) ??
                    Number.MAX_SAFE_INTEGER) ||
                left.captionNodeId.localeCompare(right.captionNodeId),
            )
          : pagePairs
    const orderedIds = orderedPairs.flatMap(
      ({ visualNodeId, captionNodeId }) => [visualNodeId, captionNodeId],
    )
    const uniqueIds = new Set(orderedIds)
    if (uniqueIds.size !== orderedIds.length) continue

    const nodesById = new Map(
      nodes
        .filter((node) => uniqueIds.has(node.id))
        .map((node) => [node.id, node]),
    )
    const slots = pairSlots
    if (
      nodesById.size !== orderedIds.length ||
      slots.length !== orderedIds.length
    ) {
      continue
    }
    for (const [index, nodeId] of orderedIds.entries()) {
      nodes[slots[index]] = nodesById.get(nodeId)!
    }
  }

  const headingScopeForAnchor = (anchorNodeId: string) => {
    const anchorIndex = nodes.findIndex((node) => node.id === anchorNodeId)
    if (anchorIndex < 0) return null
    for (let index = anchorIndex; index >= 0; index -= 1) {
      if (nodes[index].type === 'heading') {
        return { headingNodeId: nodes[index].id, anchorIndex }
      }
    }
    return null
  }
  const precedingReferenceScopes = (pair: (typeof pairs)[number]) =>
    crossReferences.flatMap((relationship) => {
      if (
        relationship.status !== 'matched' ||
        relationship.canonicalAnchor === null ||
        !relationship.targetNodeIds.includes(pair.visualNodeId) ||
        !relationship.targets.some(
          (target) =>
            target.status === 'matched' &&
            target.targetNodeId === pair.visualNodeId,
        ) ||
        !relationship.sourceBoxes.some((box) => box.page < pair.page)
      ) {
        return []
      }
      const scope = headingScopeForAnchor(relationship.canonicalAnchor.nodeId)
      return scope ? [{ ...scope, relationship }] : []
    })
  const adjacentPairRuns: Array<Array<(typeof pairs)[number]>> = []
  const positionedPairs = pairs
    .flatMap((pair) => {
      const visualIndex = nodes.findIndex(
        (node) => node.id === pair.visualNodeId,
      )
      const captionIndex = nodes.findIndex(
        (node) => node.id === pair.captionNodeId,
      )
      return visualIndex >= 0 &&
        captionIndex === visualIndex + 1 &&
        pair.sourceBox
        ? [{ pair, visualIndex, captionIndex }]
        : []
    })
    .sort(
      (left, right) =>
        left.visualIndex - right.visualIndex ||
        left.pair.visualNodeId.localeCompare(right.pair.visualNodeId),
    )
  for (const positioned of positionedPairs) {
    const run = adjacentPairRuns.at(-1)
    const previousPair = run?.at(-1)
    const previousCaptionIndex = previousPair
      ? nodes.findIndex((node) => node.id === previousPair.captionNodeId)
      : -1
    if (run && positioned.visualIndex === previousCaptionIndex + 1) {
      run.push(positioned.pair)
    } else {
      adjacentPairRuns.push([positioned.pair])
    }
  }
  const deferredPairRuns = adjacentPairRuns.filter((run) => {
    if (run.length < 2 || Object.keys(nodeSourceEvidence).length === 0) {
      return false
    }
    const provedScopes = new Set(
      run.flatMap((pair) => {
        const orderedReferences = precedingReferenceScopes(pair).sort(
          (left, right) =>
            right.anchorIndex - left.anchorIndex ||
            left.relationship.id.localeCompare(right.relationship.id),
        )
        return orderedReferences[0]?.headingNodeId
          ? [orderedReferences[0].headingNodeId]
          : []
      }),
    )
    return provedScopes.size >= 2
  })
  const deferredVisualPairIds = new Set(
    deferredPairRuns.flatMap((run) => run.map((pair) => pair.visualNodeId)),
  )

  const containmentCandidates = pairs
    .flatMap((pair) => {
      const visualIndex = nodes.findIndex(
        (node) => node.id === pair.visualNodeId,
      )
      const captionIndex = nodes.findIndex(
        (node) => node.id === pair.captionNodeId,
      )
      if (
        visualIndex < 0 ||
        captionIndex !== visualIndex + 1 ||
        !pair.sourceBox
      ) {
        return []
      }
      const sourceColumn = (
        box: NormalizedSourceBox,
      ): 'left' | 'right' | 'span' => {
        if (box.width >= 0.65 || (box.x < 0.45 && box.x + box.width > 0.55)) {
          return 'span'
        }
        return box.x + box.width / 2 < 0.5 ? 'left' : 'right'
      }
      const pairSourceColumn = sourceColumn(pair.sourceBox)
      if (
        (pair.column === 'left' || pair.column === 'right') &&
        pair.column !== pairSourceColumn
      ) {
        return []
      }
      const sourceColumnRank = (box: NormalizedSourceBox) => {
        const column = sourceColumn(box)
        return column === 'right' ? 1 : column === 'left' ? 0 : -1
      }
      const exactReferenceEnvelope = (
        boxes: readonly NormalizedSourceBox[],
      ) => {
        const first = boxes[0]
        if (
          !first ||
          boxes.some(
            (box) =>
              box.page !== first.page ||
              box.rotation !== first.rotation ||
              box.method !== first.method ||
              !validNormalizedSourceBox(box),
          )
        ) {
          return null
        }
        const left = Math.min(...boxes.map((box) => box.x))
        const top = Math.min(...boxes.map((box) => box.y))
        const right = Math.max(...boxes.map((box) => box.x + box.width))
        const bottom = Math.max(...boxes.map((box) => box.y + box.height))
        const envelope: NormalizedSourceBox = {
          page: first.page,
          x: rounded(left),
          y: rounded(top),
          width: rounded(right - left),
          height: rounded(bottom - top),
          rotation: first.rotation,
          method: first.method,
        }
        return validNormalizedSourceBox(envelope) ? envelope : null
      }
      const exactReferences = crossReferences
        .flatMap((relationship) => {
          if (
            relationship.status !== 'matched' ||
            relationship.canonicalAnchor === null ||
            !relationship.targetNodeIds.includes(pair.visualNodeId) ||
            !relationship.targets.some(
              (target) =>
                target.status === 'matched' &&
                target.targetNodeId === pair.visualNodeId,
            )
          ) {
            return []
          }
          const referenceBox = exactReferenceEnvelope(relationship.sourceBoxes)
          if (!referenceBox) return []
          const anchorIndex = nodes.findIndex(
            (node) => node.id === relationship.canonicalAnchor!.nodeId,
          )
          return anchorIndex >= 0
            ? [
                {
                  anchorIndex,
                  relationship,
                  referenceBox,
                },
              ]
            : []
        })
        .flatMap((candidate) => {
          let containingHeadingIndex = -1
          for (let index = candidate.anchorIndex; index >= 0; index -= 1) {
            if (nodes[index].type === 'heading') {
              containingHeadingIndex = index
              break
            }
          }
          const containingHeading = nodes[containingHeadingIndex]
          return [
            {
              ...candidate,
              containingHeadingIndex,
              containingHeading:
                containingHeading?.type === 'heading'
                  ? containingHeading
                  : null,
            },
          ]
        })
      const isDeferredMultiScopePair = deferredVisualPairIds.has(
        pair.visualNodeId,
      )
      const precedingExactReferences = exactReferences.filter(
        (candidate) =>
          candidate.referenceBox.page < pair.page ||
          (candidate.referenceBox.page === pair.page &&
            (sourceColumnRank(candidate.referenceBox) <
              sourceColumnRank(pair.sourceBox!) ||
              (sourceColumnRank(candidate.referenceBox) ===
                sourceColumnRank(pair.sourceBox!) &&
                candidate.referenceBox.y <= pair.sourceBox!.y))),
      )
      const ownershipReferences =
        isDeferredMultiScopePair && precedingExactReferences.length > 0
          ? precedingExactReferences
          : exactReferences
      if (ownershipReferences.length === 0) return []

      const headingScopeIds = new Set(
        ownershipReferences.map(
          (candidate) =>
            candidate.containingHeading?.id ?? 'document-root-heading-scope',
        ),
      )
      const sourceOrderedReferences = [...ownershipReferences].sort(
        (left, right) =>
          left.anchorIndex - right.anchorIndex ||
          left.referenceBox.page - right.referenceBox.page ||
          sourceColumnRank(left.referenceBox) -
            sourceColumnRank(right.referenceBox) ||
          left.referenceBox.y - right.referenceBox.y ||
          left.relationship.id.localeCompare(right.relationship.id),
      )
      const hasNodeSourceEvidence = Object.keys(nodeSourceEvidence).length > 0
      const samePhysicalLane = (box: NormalizedSourceBox) => {
        if (pair.column === 'left' || pair.column === 'right') {
          const headingColumn = sourceColumn(box)
          return headingColumn === pair.column || headingColumn === 'span'
        }
        const overlap =
          Math.min(
            pair.sourceBox!.x + pair.sourceBox!.width,
            box.x + box.width,
          ) - Math.max(pair.sourceBox!.x, box.x)
        return overlap > Math.min(pair.sourceBox!.width, box.width) * 0.25
      }
      const physicalHeadingCandidates = hasNodeSourceEvidence
        ? nodes.flatMap((node, index) => {
            if (node.type !== 'heading') return []
            const precedingBoxes = (
              nodeSourceEvidence[node.id]?.boxes ?? []
            ).filter(
              (box) =>
                box.page <= pair.page &&
                samePhysicalLane(box) &&
                (box.page < pair.page || box.y <= pair.sourceBox!.y + 0.004),
            )
            const latestBox = precedingBoxes.sort(
              (left, right) =>
                right.page - left.page ||
                sourceColumnRank(right) - sourceColumnRank(left) ||
                right.y - left.y ||
                right.x - left.x,
            )[0]
            return latestBox ? [{ index, box: latestBox }] : []
          })
        : nodes.flatMap((node, index) =>
            index < visualIndex && node.type === 'heading'
              ? [
                  {
                    index,
                    box: null,
                  },
                ]
              : [],
          )
      const physicalHeadingIndex =
        physicalHeadingCandidates
          .sort((left, right) => {
            if (left.box && right.box) {
              return (
                left.box.page - right.box.page ||
                sourceColumnRank(left.box) - sourceColumnRank(right.box) ||
                left.box.y - right.box.y ||
                left.box.x - right.box.x ||
                left.index - right.index
              )
            }
            return left.index - right.index
          })
          .at(-1)?.index ?? -1
      const physicalHeading = nodes[physicalHeadingIndex]
      const physicalHeadingScopeId =
        physicalHeading?.type === 'heading' ? physicalHeading.id : null

      if (physicalHeadingScopeId !== null && headingScopeIds.size > 1) {
        if (isDeferredMultiScopePair) {
          // A later-page run of adjacent visual-caption pairs can be a
          // source-authored float queue. Its exact anchors, not the final
          // heading before that queue, prove the intended Appendix scopes.
        } else {
          recordSourceOrderFloatFallback({
            page: pair.page,
            visualNodeId: pair.visualNodeId,
            reason: `exact references span ${headingScopeIds.size} distinct heading or document-root scopes.`,
            sourceBoxes: sourceOrderedReferences.map(
              (candidate) => candidate.referenceBox,
            ),
            target: {
              regionIds: sourceOrderedReferences.map(
                (candidate) => candidate.relationship.referenceRegionId,
              ),
              markerId: null,
            },
          })
          return []
        }
      }

      const scopeDistance = new Map<string, number>()
      for (const candidate of ownershipReferences) {
        const scopeId =
          candidate.containingHeading?.id ?? 'document-root-heading-scope'
        scopeDistance.set(
          scopeId,
          Math.min(
            scopeDistance.get(scopeId) ?? Number.MAX_SAFE_INTEGER,
            Math.abs(candidate.anchorIndex - visualIndex),
          ),
        )
      }
      const orderedScopeDistances = [...scopeDistance].sort(
        ([leftId, leftDistance], [rightId, rightDistance]) =>
          leftDistance - rightDistance || leftId.localeCompare(rightId),
      )
      const nearestScopeIsUnique =
        orderedScopeDistances.length === 1 ||
        orderedScopeDistances[0][1] < orderedScopeDistances[1][1]
      if (physicalHeadingScopeId === null && !nearestScopeIsUnique) {
        recordSourceOrderFloatFallback({
          page: pair.page,
          visualNodeId: pair.visualNodeId,
          reason:
            'exact references are equally near in distinct heading or document-root scopes.',
          sourceBoxes: sourceOrderedReferences.map(
            (candidate) => candidate.referenceBox,
          ),
          target: {
            regionIds: sourceOrderedReferences.map(
              (candidate) => candidate.relationship.referenceRegionId,
            ),
            markerId: null,
          },
        })
        return []
      }
      const selectedReferenceScopeId =
        !isDeferredMultiScopePair &&
        physicalHeadingScopeId !== null &&
        headingScopeIds.has(physicalHeadingScopeId)
          ? physicalHeadingScopeId
          : orderedScopeDistances[0][0]
      const selectedReferences = ownershipReferences
        .filter(
          (candidate) =>
            (candidate.containingHeading?.id ??
              'document-root-heading-scope') === selectedReferenceScopeId,
        )
        .sort(
          (left, right) =>
            Math.abs(left.anchorIndex - visualIndex) -
              Math.abs(right.anchorIndex - visualIndex) ||
            left.anchorIndex - right.anchorIndex ||
            left.relationship.id.localeCompare(right.relationship.id),
        )
      const firstExactReference = selectedReferences[0]
      const containingHeading = firstExactReference.containingHeading
      const referenceHeadingScopeId =
        containingHeading?.id ?? 'document-root-heading-scope'
      if (
        !isDeferredMultiScopePair &&
        physicalHeadingScopeId !== null &&
        physicalHeadingScopeId !== referenceHeadingScopeId
      ) {
        recordSourceOrderFloatFallback({
          page: pair.page,
          visualNodeId: pair.visualNodeId,
          reason: `the physical heading scope ${physicalHeadingScopeId} differs from exact-reference scope ${referenceHeadingScopeId}.`,
          relationshipId: firstExactReference.relationship.id,
          sourceBoxes: [
            pair.sourceBox,
            ...selectedReferences.map((candidate) => candidate.referenceBox),
          ],
          target: {
            regionIds: selectedReferences.map(
              (candidate) => candidate.relationship.referenceRegionId,
            ),
            markerId: null,
          },
        })
        return []
      }
      if (!containingHeading) return []
      const boundaryIndex = nodes.findIndex(
        (node, index) =>
          index > firstExactReference.containingHeadingIndex &&
          node.type === 'heading' &&
          node.level <= containingHeading.level,
      )
      const scopeEndIndex = boundaryIndex < 0 ? nodes.length : boundaryIndex
      if (
        visualIndex > firstExactReference.containingHeadingIndex &&
        captionIndex < scopeEndIndex
      ) {
        return []
      }
      return [
        {
          ...pair,
          sourceIndex: visualIndex,
          anchorNodeId:
            firstExactReference.relationship.canonicalAnchor!.nodeId,
          scopeHeadingNodeId: containingHeading.id,
          boundaryNodeId: boundaryIndex < 0 ? null : nodes[boundaryIndex].id,
          referenceRegionId: firstExactReference.relationship.referenceRegionId,
          relationshipId: firstExactReference.relationship.id,
          referenceBox: firstExactReference.referenceBox,
        },
      ]
    })
    .sort(
      (left, right) =>
        left.sourceIndex - right.sourceIndex ||
        left.visualNodeId.localeCompare(right.visualNodeId),
    )

  for (const pair of containmentCandidates) {
    const visualIndex = nodes.findIndex((node) => node.id === pair.visualNodeId)
    const captionIndex = nodes.findIndex(
      (node) => node.id === pair.captionNodeId,
    )
    const anchorIndex = nodes.findIndex((node) => node.id === pair.anchorNodeId)
    const boundaryIndex =
      pair.boundaryNodeId === null
        ? nodes.length
        : nodes.findIndex((node) => node.id === pair.boundaryNodeId)
    if (
      visualIndex < 0 ||
      captionIndex !== visualIndex + 1 ||
      anchorIndex < 0 ||
      boundaryIndex <= anchorIndex
    ) {
      continue
    }
    const nodeSnapshot = [...nodes]
    const pairNodes = nodes.splice(visualIndex, 2)
    const insertionIndex =
      pair.boundaryNodeId === null
        ? nodes.length
        : nodes.findIndex((node) => node.id === pair.boundaryNodeId)
    if (insertionIndex < 0) {
      nodes.splice(visualIndex, 0, ...pairNodes)
      continue
    }
    const scopeHeadingIndex = nodes.findIndex(
      (node) => node.id === pair.scopeHeadingNodeId,
    )
    const laterPeerIndex =
      scopeHeadingIndex < 0
        ? -1
        : (pairs
            .filter(
              (candidate) =>
                candidate.visualNodeId !== pair.visualNodeId &&
                comparePairScopedOrder(pair, candidate) < 0,
            )
            .flatMap((candidate) => {
              const candidateIndex = nodes.findIndex(
                (node) => node.id === candidate.visualNodeId,
              )
              return candidateIndex > scopeHeadingIndex &&
                candidateIndex < insertionIndex
                ? [candidateIndex]
                : []
            })
            .sort((left, right) => left - right)[0] ?? -1)
    nodes.splice(
      laterPeerIndex >= 0 ? laterPeerIndex : insertionIndex,
      0,
      ...pairNodes,
    )
    if (!preservesAtomicSourcePairOrder()) {
      restoreNodes(nodeSnapshot)
      recordSourceOrderFloatFallback({
        page: pair.page,
        visualNodeId: pair.visualNodeId,
        reason:
          'the proposed reference-scope placement would reverse source-proved visual-caption pair order.',
        relationshipId: pair.relationshipId,
        sourceBoxes: [
          ...(pair.sourceBox ? [pair.sourceBox] : []),
          pair.referenceBox,
        ],
        target: {
          regionIds: [pair.referenceRegionId],
          markerId: null,
        },
      })
      continue
    }
    diagnostics.push({
      code: 'RESOLVED_READING_ORDER',
      severity: 'info',
      page: pair.page,
      message: `Placed canonical visual ${pair.visualNodeId} within its one proved reference scope using the nearest exact anchor while preserving source order among visual pairs.`,
      relationshipId: pair.relationshipId,
      sourceBoxes: [pair.referenceBox],
      target: {
        regionIds: [pair.referenceRegionId],
        markerId: null,
      },
    })
  }

  for (const run of deferredPairRuns) {
    const runSnapshot = [...nodes]
    const movedPairs: Array<{
      pair: (typeof pairs)[number]
      precedingReferenceRegionId: string
      followingReferenceRegionId: string
    }> = []
    const scopedPairs = run.map((pair) => {
      const references = precedingReferenceScopes(pair).sort(
        (left, right) =>
          right.anchorIndex - left.anchorIndex ||
          left.relationship.id.localeCompare(right.relationship.id),
      )
      return {
        pair,
        owner: references[0] ?? null,
        hasMatchedReference: crossReferences.some(
          (relationship) =>
            relationship.status === 'matched' &&
            relationship.canonicalAnchor !== null &&
            relationship.targetNodeIds.includes(pair.visualNodeId) &&
            relationship.targets.some(
              (target) =>
                target.status === 'matched' &&
                target.targetNodeId === pair.visualNodeId,
            ),
        ),
      }
    })
    for (const [pairIndex, scopedPair] of scopedPairs.entries()) {
      if (scopedPair.owner || scopedPair.hasMatchedReference) continue
      const precedingOwner = scopedPairs
        .slice(0, pairIndex)
        .reverse()
        .find((candidate) => candidate.owner)?.owner
      const followingOwner = scopedPairs
        .slice(pairIndex + 1)
        .find((candidate) => candidate.owner)?.owner
      if (!precedingOwner || !followingOwner) continue

      const precedingHeadingPosition = initialNodePositions.get(
        precedingOwner.headingNodeId,
      )
      const followingHeadingPosition = initialNodePositions.get(
        followingOwner.headingNodeId,
      )
      if (
        precedingHeadingPosition === undefined ||
        followingHeadingPosition === undefined ||
        precedingHeadingPosition > followingHeadingPosition
      ) {
        continue
      }
      const slotHeading =
        precedingOwner.headingNodeId === followingOwner.headingNodeId
          ? initialNodesById.get(precedingOwner.headingNodeId)
          : (nodes
              .filter(
                (node) =>
                  node.type === 'heading' &&
                  (initialNodePositions.get(node.id) ?? -1) >
                    precedingHeadingPosition &&
                  (initialNodePositions.get(node.id) ??
                    Number.MAX_SAFE_INTEGER) < followingHeadingPosition,
              )
              .sort(
                (left, right) =>
                  (initialNodePositions.get(right.id) ?? -1) -
                  (initialNodePositions.get(left.id) ?? -1),
              )[0] ?? initialNodesById.get(precedingOwner.headingNodeId))
      if (slotHeading?.type !== 'heading') continue

      const visualIndex = nodes.findIndex(
        (node) => node.id === scopedPair.pair.visualNodeId,
      )
      const captionIndex = nodes.findIndex(
        (node) => node.id === scopedPair.pair.captionNodeId,
      )
      const slotHeadingIndex = nodes.findIndex(
        (node) => node.id === slotHeading.id,
      )
      if (
        visualIndex < 0 ||
        captionIndex !== visualIndex + 1 ||
        slotHeadingIndex < 0
      ) {
        continue
      }
      const originalBoundaryIndex = nodes.findIndex(
        (node, index) =>
          index > slotHeadingIndex &&
          node.type === 'heading' &&
          node.level <= slotHeading.level,
      )
      const scopeEndIndex =
        originalBoundaryIndex < 0 ? nodes.length : originalBoundaryIndex
      if (visualIndex > slotHeadingIndex && captionIndex < scopeEndIndex) {
        continue
      }

      const boundaryNodeId =
        originalBoundaryIndex < 0 ? null : nodes[originalBoundaryIndex].id
      const pairNodes = nodes.splice(visualIndex, 2)
      const insertionBoundary =
        boundaryNodeId === null
          ? nodes.length
          : nodes.findIndex((node) => node.id === boundaryNodeId)
      if (insertionBoundary < 0) {
        nodes.splice(visualIndex, 0, ...pairNodes)
        continue
      }
      const currentSlotHeadingIndex = nodes.findIndex(
        (node) => node.id === slotHeading.id,
      )
      const laterPeerIndex =
        run
          .filter(
            (candidate) =>
              candidate.visualNodeId !== scopedPair.pair.visualNodeId &&
              comparePairScopedOrder(scopedPair.pair, candidate) < 0,
          )
          .flatMap((candidate) => {
            const candidateIndex = nodes.findIndex(
              (node) => node.id === candidate.visualNodeId,
            )
            return candidateIndex > currentSlotHeadingIndex &&
              candidateIndex < insertionBoundary
              ? [candidateIndex]
              : []
          })
          .sort((left, right) => left - right)[0] ?? -1
      nodes.splice(
        laterPeerIndex >= 0 ? laterPeerIndex : insertionBoundary,
        0,
        ...pairNodes,
      )
      movedPairs.push({
        pair: scopedPair.pair,
        precedingReferenceRegionId:
          precedingOwner.relationship.referenceRegionId,
        followingReferenceRegionId:
          followingOwner.relationship.referenceRegionId,
      })
    }
    if (movedPairs.length === 0) continue
    if (!preservesAtomicPhysicalSourcePairOrder()) {
      restoreNodes(runSnapshot)
      for (const moved of movedPairs) {
        recordSourceOrderFloatFallback({
          page: moved.pair.page,
          visualNodeId: moved.pair.visualNodeId,
          reason:
            'the only bounded inferred-scope placement would reverse source-proved visual-caption pair order.',
          sourceBoxes: moved.pair.sourceBox ? [moved.pair.sourceBox] : [],
          target: {
            regionIds: [
              moved.precedingReferenceRegionId,
              moved.followingReferenceRegionId,
            ],
            markerId: null,
          },
        })
      }
      continue
    }
    for (const moved of movedPairs) {
      diagnostics.push({
        code: 'RESOLVED_READING_ORDER',
        severity: 'info',
        page: moved.pair.page,
        message: `Placed canonical visual ${moved.pair.visualNodeId} in the unique slot bounded by adjacent exact-reference scopes while preserving source-proved visual-caption pair order.`,
        sourceBoxes: moved.pair.sourceBox ? [moved.pair.sourceBox] : [],
        target: {
          regionIds: [
            moved.precedingReferenceRegionId,
            moved.followingReferenceRegionId,
          ],
          markerId: null,
        },
      })
    }
  }
}
