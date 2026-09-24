import type {
  NodeSourceEvidence,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReadingOrderGraph,
  PdfVisualAsset,
  PdfVisualRelationship,
} from './import-types'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import type { ResearchNode, ResearchPaper } from './schema'

export type CanonicalFloatScopeEvidence = {
  interruptedRegionIds: readonly [string, string]
  scopeRegionIds: readonly string[]
}

export function normalizedText(value: string) {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

export function characterCount(value: string) {
  return [...value].length
}

export function nodeText(node: ResearchNode, validatedVisualText = '') {
  if (node.type === 'footnote') {
    return `${node.markerText ?? node.label} ${node.text}`
  }
  if ('text' in node) {
    return node.type === 'paragraph' && node.list?.markerText
      ? `${node.list.markerText} ${node.text}`
      : node.text
  }
  if (node.type !== 'figure') return ''
  const tableText = node.table?.rows
    .flatMap((row) => row.cells.map((cell) => cell.text))
    .join(' ')
  const normalizedTableText = normalizedText(tableText ?? '')
  const normalizedVisualText = normalizedText(validatedVisualText)
  return [
    tableText,
    normalizedVisualText && !normalizedTableText.includes(normalizedVisualText)
      ? validatedVisualText
      : '',
  ]
    .filter(Boolean)
    .join(' ')
}

const POSITIONAL_VISUAL_RENDITIONS = new Set<PdfVisualAsset['rendition']>([
  'source-preserved',
  'browser-composite-raster',
  'source-page-crop',
])

export function validatedVisualRepresentationByNode(
  paper: ResearchPaper,
  provenance: Record<string, NodeSourceEvidence> | undefined,
  relationships: PdfVisualRelationship[] | undefined,
  assets: PdfVisualAsset[] | undefined,
  regions?: readonly PdfPageRegion[],
  pages?: readonly PdfPageAnalysis[],
) {
  const validatedRelationships = validatedPdfVisualRelationships({
    paper,
    provenance,
    relationships,
    assets,
    regions,
    pages,
  })
  const assetsById = new Map((assets ?? []).map((asset) => [asset.id, asset]))
  const representedByNode = new Map<string, string[]>()
  const sourceRegionIdsByNode = new Map<string, string[]>()
  const positionalEligibilityByNode = new Map<string, boolean>()
  const lineageConnectorNodeIds = new Set<string>()
  for (const relationship of validatedRelationships) {
    if (relationship.canonicalNodeId === null) continue
    const renderedAssets = relationship.assetIds
      .map((assetId) => assetsById.get(assetId))
      .filter((asset): asset is PdfVisualAsset => Boolean(asset))
    if (renderedAssets.length !== relationship.assetIds.length) continue
    const captionNode = paper.nodes.find(
      (node) => node.id === relationship.captionNodeId,
    )
    const sourceTextEquation =
      relationship.kind === 'equation' &&
      relationship.altTextSource === 'source-text'
    const selfCaptionedSourceText = Boolean(
      sourceTextEquation &&
      relationship.sourceRegionIds.includes(relationship.captionRegionId) &&
      captionNode?.type === 'caption' &&
      normalizedText(captionNode.text) ===
        normalizedText(relationship.sourceText),
    )
    if (selfCaptionedSourceText) {
      lineageConnectorNodeIds.add(relationship.canonicalNodeId)
    }
    const positional =
      !sourceTextEquation &&
      renderedAssets.every((asset) =>
        POSITIONAL_VISUAL_RENDITIONS.has(asset.rendition),
      )
    positionalEligibilityByNode.set(
      relationship.canonicalNodeId,
      (positionalEligibilityByNode.get(relationship.canonicalNodeId) ?? true) &&
        positional,
    )
    if (positional && relationship.sourceRegionIds.length > 0) {
      const sourceRegionIds =
        sourceRegionIdsByNode.get(relationship.canonicalNodeId) ?? []
      for (const regionId of relationship.sourceRegionIds) {
        if (!sourceRegionIds.includes(regionId)) sourceRegionIds.push(regionId)
      }
      sourceRegionIdsByNode.set(relationship.canonicalNodeId, sourceRegionIds)
      if (relationship.sourceText.trim().length === 0) {
        lineageConnectorNodeIds.add(relationship.canonicalNodeId)
      }
    }
    if (
      selfCaptionedSourceText ||
      relationship.sourceRegionIds.length === 0 ||
      relationship.sourceText.trim().length === 0
    ) {
      continue
    }
    const values = representedByNode.get(relationship.canonicalNodeId) ?? []
    values.push(relationship.sourceText)
    representedByNode.set(relationship.canonicalNodeId, values)
    if (!positional) {
      const sourceRegionIds =
        sourceRegionIdsByNode.get(relationship.canonicalNodeId) ?? []
      for (const regionId of relationship.sourceRegionIds) {
        if (!sourceRegionIds.includes(regionId)) sourceRegionIds.push(regionId)
      }
      sourceRegionIdsByNode.set(relationship.canonicalNodeId, sourceRegionIds)
    }
  }
  return {
    textByNode: new Map(
      [...representedByNode].map(([id, values]) => [id, values.join(' ')]),
    ),
    sourceRegionIdsByNode,
    positionalNodeIds: new Set(
      [...positionalEligibilityByNode]
        .filter(([, positional]) => positional)
        .map(([id]) => id),
    ),
    lineageConnectorNodeIds,
  }
}

function smallLongestCommonSubsequence(source: string[], output: string[]) {
  const previous = new Uint32Array(output.length + 1)
  const current = new Uint32Array(output.length + 1)
  for (const sourceCharacter of source) {
    current[0] = 0
    for (let outputIndex = 1; outputIndex <= output.length; outputIndex += 1) {
      current[outputIndex] =
        sourceCharacter === output[outputIndex - 1]
          ? previous[outputIndex - 1] + 1
          : Math.max(previous[outputIndex], current[outputIndex - 1])
    }
    previous.set(current)
  }
  return previous[output.length]
}

function isSubsequence(candidate: string[], value: string[]) {
  let candidateIndex = 0
  for (const character of value) {
    if (character === candidate[candidateIndex]) candidateIndex += 1
    if (candidateIndex === candidate.length) return true
  }
  return candidate.length === 0
}

function bigintPopulationCount(value: bigint) {
  let remaining = value
  let count = 0
  const mask = 0xffff_ffffn
  while (remaining > 0n) {
    let chunk = Number(remaining & mask) >>> 0
    chunk -= (chunk >>> 1) & 0x5555_5555
    chunk = (chunk & 0x3333_3333) + ((chunk >>> 2) & 0x3333_3333)
    count += (((chunk + (chunk >>> 4)) & 0x0f0f_0f0f) * 0x0101_0101) >>> 24
    remaining >>= 32n
  }
  return count
}

function bitsetLongestCommonSubsequence(source: string[], output: string[]) {
  const columns = source.length <= output.length ? source : output
  const rows = source.length <= output.length ? output : source
  const matchesByCharacter = new Map<string, bigint>()
  for (const [index, character] of columns.entries()) {
    matchesByCharacter.set(
      character,
      (matchesByCharacter.get(character) ?? 0n) | (1n << BigInt(index)),
    )
  }
  let state = 0n
  for (const character of rows) {
    const matches = matchesByCharacter.get(character) ?? 0n
    const available = matches | state
    state = available & ~(available - ((state << 1n) | 1n))
  }
  return bigintPopulationCount(state)
}

export function orderedMatchedCharacters(source: string, output: string) {
  if (source === output) return characterCount(source)
  const sourceCharacters = [...source]
  const outputCharacters = [...output]
  let prefixLength = 0
  while (
    prefixLength < sourceCharacters.length &&
    prefixLength < outputCharacters.length &&
    sourceCharacters[prefixLength] === outputCharacters[prefixLength]
  ) {
    prefixLength += 1
  }
  let sourceEnd = sourceCharacters.length
  let outputEnd = outputCharacters.length
  while (
    sourceEnd > prefixLength &&
    outputEnd > prefixLength &&
    sourceCharacters[sourceEnd - 1] === outputCharacters[outputEnd - 1]
  ) {
    sourceEnd -= 1
    outputEnd -= 1
  }
  const suffixLength = sourceCharacters.length - sourceEnd
  const sourceMiddle = sourceCharacters.slice(prefixLength, sourceEnd)
  const outputMiddle = outputCharacters.slice(prefixLength, outputEnd)
  const shorter =
    sourceMiddle.length <= outputMiddle.length ? sourceMiddle : outputMiddle
  const longer =
    sourceMiddle.length <= outputMiddle.length ? outputMiddle : sourceMiddle
  const middleMatch = isSubsequence(shorter, longer)
    ? shorter.length
    : sourceMiddle.length * outputMiddle.length <= 1_000_000
      ? smallLongestCommonSubsequence(sourceMiddle, outputMiddle)
      : bitsetLongestCommonSubsequence(sourceMiddle, outputMiddle)
  return prefixLength + middleMatch + suffixLength
}

export function occurrenceBoundedMatchedCharacters(
  source: string,
  output: string,
) {
  const remaining = new Map<string, number>()
  for (const character of output) {
    remaining.set(character, (remaining.get(character) ?? 0) + 1)
  }
  let matched = 0
  for (const character of source) {
    const count = remaining.get(character) ?? 0
    if (count === 0) continue
    remaining.set(character, count - 1)
    matched += 1
  }
  return matched
}

function countOccurrences(value: string, candidate: string) {
  let count = 0
  let cursor = 0
  while (cursor <= value.length - candidate.length) {
    const position = value.indexOf(candidate, cursor)
    if (position < 0) break
    count += 1
    cursor = position + candidate.length
  }
  return count
}

export function duplicateCanonicalSpanCount(
  source: string,
  paper: ResearchPaper,
) {
  const canonicalCounts = new Map<string, number>()
  for (const node of paper.nodes) {
    if (!('text' in node)) continue
    const value = normalizedText(node.text)
    if (characterCount(value) < 16) continue
    canonicalCounts.set(value, (canonicalCounts.get(value) ?? 0) + 1)
  }
  return [...canonicalCounts].reduce((total, [value, count]) => {
    if (count < 2) return total
    return (
      total + Math.max(count - Math.max(countOccurrences(source, value), 1), 0)
    )
  }, 0)
}

export function duplicateCanonicalRoleNodeIds(paper: ResearchPaper) {
  const implicated = new Set<string>()
  const normalizedTitle = normalizedText(paper.title)
  const headings = paper.nodes.filter(
    (node): node is Extract<ResearchNode, { type: 'heading' }> =>
      node.type === 'heading',
  )
  if (normalizedTitle) {
    const titleRoleNodes = paper.nodes.filter(
      (
        node,
      ): node is Extract<ResearchNode, { type: 'heading' | 'paragraph' }> =>
        (node.type === 'heading' || node.type === 'paragraph') &&
        normalizedText(node.text) === normalizedTitle,
    )
    if (titleRoleNodes.length > 1) {
      for (const node of titleRoleNodes) implicated.add(node.id)
    }
  }
  for (let index = 1; index < headings.length; index += 1) {
    const previous = headings[index - 1]
    const current = headings[index]
    const previousText = normalizedText(previous.text)
    if (previousText && previousText === normalizedText(current.text)) {
      implicated.add(previous.id)
      implicated.add(current.id)
    }
  }
  return [...implicated]
}

export function canonicalFlowOrderViolationNodeIds(
  paper: ResearchPaper,
  provenance: Record<string, NodeSourceEvidence> | undefined,
  orderedRegions: readonly PdfPageRegion[],
  canonicalFloatScopes: readonly CanonicalFloatScopeEvidence[] = [],
) {
  if (!provenance || orderedRegions.length === 0) return []
  const allRegionOrder = new Map(
    orderedRegions.map((region, index) => [region.id, index]),
  )
  const regionOrder = new Map(
    orderedRegions.flatMap((region, index) =>
      region.kind === 'body' || region.kind === 'spanning'
        ? ([[region.id, index]] as const)
        : [],
    ),
  )
  const validatedFloatScopeRegionIds = canonicalFloatScopes.flatMap(
    ({ interruptedRegionIds, scopeRegionIds }) => {
      const [startRegionId, endRegionId] = interruptedRegionIds
      const start = regionOrder.get(startRegionId)
      const end = regionOrder.get(endRegionId)
      if (
        start === undefined ||
        end === undefined ||
        start >= end ||
        scopeRegionIds.length === 0 ||
        new Set(scopeRegionIds).size !== scopeRegionIds.length ||
        scopeRegionIds.some((regionId) => {
          const position = allRegionOrder.get(regionId)
          return position === undefined || position <= start || position >= end
        })
      ) {
        return []
      }
      const scopeBodyRegionIds = new Set(
        scopeRegionIds.filter((regionId) => regionOrder.has(regionId)),
      )
      const interiorBodyRegionIds = new Set(
        [...regionOrder.entries()].flatMap(([regionId, position]) =>
          position > start && position < end ? [regionId] : [],
        ),
      )
      if (
        scopeBodyRegionIds.size === 0 ||
        scopeBodyRegionIds.size !== interiorBodyRegionIds.size ||
        [...interiorBodyRegionIds].some(
          (regionId) => !scopeBodyRegionIds.has(regionId),
        )
      ) {
        return []
      }
      return [scopeBodyRegionIds]
    },
  )
  const intervals: Array<{
    nodeId: string
    regionIds: Set<string>
    minimum: number
    maximum: number
  }> = []
  const implicated = new Set<string>()
  for (const node of paper.nodes) {
    if (node.type !== 'heading' && node.type !== 'paragraph') continue
    const orderedRegionIds = (provenance[node.id]?.regionIds ?? []).filter(
      (regionId) => regionOrder.has(regionId),
    )
    if (orderedRegionIds.length === 0) continue
    if (
      validatedFloatScopeRegionIds.some((scopeRegionIds) =>
        orderedRegionIds.every((regionId) => scopeRegionIds.has(regionId)),
      )
    ) {
      continue
    }
    const positions = orderedRegionIds.map((regionId) =>
      regionOrder.get(regionId)!,
    )
    const interval = {
      nodeId: node.id,
      regionIds: new Set(orderedRegionIds),
      minimum: Math.min(...positions),
      maximum: Math.max(...positions),
    }
    for (const previous of intervals) {
      const sharesSourceRegion = [...interval.regionIds].some((regionId) =>
        previous.regionIds.has(regionId),
      )
      if (!sharesSourceRegion && interval.minimum < previous.maximum) {
        implicated.add(previous.nodeId)
        implicated.add(interval.nodeId)
      }
    }
    intervals.push(interval)
  }
  return [...implicated]
}

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
