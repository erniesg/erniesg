import type {
  PdfCompletenessMetrics,
  PdfCompletenessPolicy,
  PdfCitationRelationship,
  PdfLineBoundaryDecision,
  PdfNoteRelationship,
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReadingOrderGraph,
  PdfReadiness,
  PdfSemanticSignals,
  PdfVisualAsset,
  PdfVisualRelationship,
  ReconstructionDiagnostic,
} from './import-types'
import {
  verifyEquationTranscriptAdjudication,
  type EquationTranscriptContext,
} from './equation-transcript-adjudication'
import {
  groupRunsIntoLines,
  inlineHardHyphenLexicon,
  inlineUnhyphenatedLexicon,
} from './pdf-lines'
import { unprovedInlineMathAtomNodeIds } from './pdf-inline-script-integrity'
import { classifyPdfNoteMarkers } from './pdf-note-classifier'
import { reconstructPageRegions } from './pdf-regions'
import {
  decorativeNativeObjectIds,
  hasUnprovedTwoDimensionalEquationTranscript,
  isProbableDisplayEquation,
} from './pdf-visuals'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import type { ResearchNode, ResearchPaper } from './schema'
import {
  canonicalTextIntegrityIssues,
  internalReferenceIntegrityIssues,
} from './publication-integrity'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'
import { isStrictSemanticTable } from './semantic-table'

export const DEFAULT_PDF_COMPLETENESS_POLICY: PdfCompletenessPolicy = {
  minimumTextCoverage: 0.98,
  minimumAssetCoverage: 1,
  minimumRelationshipCoverage: 1,
  maximumUnresolvedObjects: 0,
  maximumOcrRequiredPages: 0,
  maximumReadingOrderDiagnostics: 0,
}

const UNRESOLVED_AUTHOR_PLACEHOLDER = 'Imported locally'

export type CanonicalFloatScopeEvidence = {
  interruptedRegionIds: readonly [string, string]
  scopeRegionIds: readonly string[]
}

type QualityInput = {
  pages: PdfPageAnalysis[]
  paper: ResearchPaper
  diagnostics: ReconstructionDiagnostic[]
  readingOrder?: PdfReadingOrderGraph
  regions?: PdfPageRegion[]
  visualRelationships?: PdfVisualRelationship[]
  assets?: PdfVisualAsset[]
  citationRelationships?: PdfCitationRelationship[]
  noteRelationships?: PdfNoteRelationship[]
  policy?: PdfCompletenessPolicy
  reclassifiedNoteReferenceCount?: number
  reclassifiedCitationCount?: number
  lineBoundaryDecisions?: PdfLineBoundaryDecision[]
  unresolvedCorruptingJoinCount?: number
  structurallyConsumedLineBoundaryCount?: number
  provenance?: Record<string, NodeSourceEvidence>
  inlineSpanLedger?: { expected: number; mapped: number }
  hyperlinkLedger?: { expected: number; mapped: number }
  sourceSha256?: string
  canonicalFloatScopes?: readonly CanonicalFloatScopeEvidence[]
}

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function normalizedText(value: string) {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function meaningPreservingText(value: string) {
  return value
    .normalize('NFC')
    .replace(/\u00ad/gu, '')
    .replace(/(?<=\p{N}[-–—])\s+(?=\p{N})/gu, '')
    .replace(/\b((?:18|19|20)\d)\s+(?=\d(?:[.,;:)]|$))/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
}

function sourceProvenBoundaryTokenText(
  value: string,
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
) {
  return value.replace(
    /([\p{L}\p{N}]+)[-‐‑]\s+([\p{L}\p{N}]+)/gu,
    (source, left: string, right: string) => {
      const hardForm = `${left}-${right}`.normalize('NFKC').toLocaleLowerCase()
      const unhyphenatedForm = `${left}${right}`
        .normalize('NFKC')
        .toLocaleLowerCase()
      if (hardHyphenLexicon.has(hardForm)) return `${left}-${right}`
      if (unhyphenatedLexicon.has(unhyphenatedForm)) return `${left}${right}`
      return source
    },
  )
}

function characterCount(value: string) {
  return [...value].length
}

function nodeText(node: ResearchNode, validatedVisualText = '') {
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

function validatedVisualRepresentationByNode(
  paper: ResearchPaper,
  provenance: Record<string, NodeSourceEvidence> | undefined,
  relationships: PdfVisualRelationship[] | undefined,
  assets: PdfVisualAsset[] | undefined,
  regions?: readonly PdfPageRegion[],
) {
  const validatedRelationships = validatedPdfVisualRelationships({
    paper,
    provenance,
    relationships,
    assets,
    regions,
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
        // A strict source-page crop is a rendered, source-backed unit even
        // when the formula/table transcript is deliberately unresolved. Link
        // its regions into conservation without pretending the image is
        // machine-readable text or increasing matched-character coverage.
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

function orderedMatchedCharacters(source: string, output: string) {
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

function occurrenceBoundedMatchedCharacters(source: string, output: string) {
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

function duplicateCanonicalSpanCount(source: string, paper: ResearchPaper) {
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

function duplicateCanonicalRoleNodeIds(paper: ResearchPaper) {
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

function canonicalFlowOrderViolationNodeIds(
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

function provenanceTextConservation({
  allRegions,
  orderedRegions,
  paper,
  provenance,
  visualRelationships,
  assets,
  lineBoundaryDecisions,
}: {
  allRegions: PdfPageRegion[]
  orderedRegions: PdfPageRegion[]
  paper: ResearchPaper
  provenance: Record<string, NodeSourceEvidence>
  visualRelationships?: PdfVisualRelationship[]
  assets?: PdfVisualAsset[]
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[]
}) {
  const allRegionMap = new Map(allRegions.map((region) => [region.id, region]))
  const sourceLines = allRegions.flatMap((region) => region.lines)
  const hardHyphenLexicon = inlineHardHyphenLexicon(sourceLines)
  const unhyphenatedLexicon = inlineUnhyphenatedLexicon(sourceLines)
  const orderedRegionMap = new Map(
    orderedRegions.map((region) => [region.id, region]),
  )
  const orderedRegionIds = new Set(orderedRegionMap.keys())
  const visualRepresentation = validatedVisualRepresentationByNode(
    paper,
    provenance,
    visualRelationships,
    assets,
    allRegions,
  )
  const visualSourceRegionIds = [
    ...visualRepresentation.sourceRegionIdsByNode.values(),
  ].flat()
  const uniqueVisualSourceRegionIds = [...new Set(visualSourceRegionIds)]
  const visualSourceRegionIdSet = new Set(uniqueVisualSourceRegionIds)
  const conservedRegions = [
    ...orderedRegions.filter(
      (region) => !visualSourceRegionIdSet.has(region.id),
    ),
    ...uniqueVisualSourceRegionIds
      .map((regionId) => allRegionMap.get(regionId))
      .filter((region): region is PdfPageRegion => Boolean(region)),
  ]
  const conservedRegionMap = new Map(
    conservedRegions.map((region) => [region.id, region]),
  )
  const regionOrder = new Map(
    conservedRegions.map((region, index) => [region.id, index]),
  )
  const outputUnits: Array<{
    key: string
    nodeId?: string
    text: string
    order: number
    regionIds: string[]
    provenanced: boolean
    conservationExempt: boolean
    positionalVisual: boolean
  }> = []

  for (const [index, node] of paper.nodes.entries()) {
    const rendered = nodeText(
      node,
      visualRepresentation.textByNode.get(node.id),
    )
    const lineageConnector =
      node.type === 'figure' &&
      visualRepresentation.lineageConnectorNodeIds.has(node.id)
    if (!normalizedText(rendered) && !lineageConnector) continue
    const evidence = provenance[node.id]
    const validEvidence = Boolean(
      evidence &&
      evidence.regionIds.length > 0 &&
      evidence.boxes.length > 0 &&
      evidence.regionIds.every((regionId) => {
        const region = allRegionMap.get(regionId)
        return region && evidence.pages.includes(region.page)
      }),
    )
    const regionIds = validEvidence ? [...new Set(evidence!.regionIds)] : []
    const visualEvidenceRegionIds = new Set(
      visualRepresentation.sourceRegionIdsByNode.get(node.id) ?? [],
    )
    const conservedEvidenceRegionIds = regionIds.filter(
      (regionId) =>
        orderedRegionIds.has(regionId) || visualEvidenceRegionIds.has(regionId),
    )
    outputUnits.push({
      key: `output:node:${node.id}`,
      nodeId: node.id,
      text: rendered,
      order: 10_000 + index,
      regionIds: conservedEvidenceRegionIds,
      provenanced: validEvidence,
      conservationExempt:
        node.type === 'figure' &&
        validEvidence &&
        conservedEvidenceRegionIds.length === 0,
      positionalVisual:
        node.type === 'figure' &&
        visualRepresentation.positionalNodeIds.has(node.id),
    })
  }

  const canonicalTitleNode = paper.nodes.some(
    (node) =>
      (node.type === 'heading' || node.type === 'paragraph') &&
      normalizedText(node.text) === normalizedText(paper.title),
  )
  const canonicalTextValues = new Set(
    paper.nodes.flatMap((node) =>
      'text' in node ? [normalizedText(node.text)] : [],
    ),
  )
  const metadataValues = [
    ...(canonicalTitleNode ? [] : [paper.title]),
    ...paper.authors,
    ...(paper.affiliations ?? []),
  ]
    .filter((value) => value !== UNRESOLVED_AUTHOR_PLACEHOLDER)
    .map((value) => ({
      value,
      representedByCanonicalNode: canonicalTextValues.has(
        normalizedText(value),
      ),
    }))
  const affiliationMarkersByRegion = new Map<string, Array<[number, number]>>()
  for (const classification of classifyPdfNoteMarkers(
    orderedRegions,
    undefined,
    lineBoundaryDecisions,
  ).classifications) {
    if (
      !classification.accepted ||
      classification.taxonomy !== 'author-affiliation-superscript'
    ) {
      continue
    }
    const ranges =
      affiliationMarkersByRegion.get(classification.referenceRegionId) ?? []
    ranges.push([classification.start, classification.end])
    affiliationMarkersByRegion.set(classification.referenceRegionId, ranges)
  }
  const markerStrippedMetadataSourceText = (region: PdfPageRegion) => {
    let value = region.text
    const ranges = [...(affiliationMarkersByRegion.get(region.id) ?? [])].sort(
      (left, right) => right[0] - left[0] || right[1] - left[1],
    )
    for (const [start, end] of ranges) {
      value = `${value.slice(0, start)}${value.slice(end)}`
    }
    return value
  }
  const sourceMarkerStrippedMetadataText = (region: PdfPageRegion) =>
    region.text.replace(/(?<=\p{L})[\d*†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+(?=(?:[\s,;]|$))/gu, '')
  const metadataRegionIds = (value: string) => {
    const comparable = (text: string) =>
      text
        .toLocaleLowerCase()
        .replace(/(\p{N})(?=\p{L})/gu, '$1 ')
        .replace(/(\p{L})(?=\p{N})/gu, '$1 ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
    const target = comparable(value)
    if (!target) return []
    const representations = [
      (region: PdfPageRegion) => region.text,
      markerStrippedMetadataSourceText,
      sourceMarkerStrippedMetadataText,
    ]
    const candidates: Array<{
      regionIds: string[]
      exact: boolean
      extraCharacters: number
      start: number
      representation: number
    }> = []
    for (const [
      representationIndex,
      representation,
    ] of representations.entries()) {
      for (let start = 0; start < orderedRegions.length; start += 1) {
        let combined = ''
        for (
          let end = start;
          end < orderedRegions.length && end < start + 8;
          end += 1
        ) {
          combined = [combined, comparable(representation(orderedRegions[end]))]
            .filter(Boolean)
            .join(' ')
          if (` ${combined} `.includes(` ${target} `)) {
            candidates.push({
              regionIds: orderedRegions
                .slice(start, end + 1)
                .map((region) => region.id),
              exact: combined === target,
              extraCharacters: combined.length - target.length,
              start,
              representation: representationIndex,
            })
            break
          }
          if (combined.length > target.length * 2 + 32) break
        }
      }
    }
    return (
      candidates.sort(
        (left, right) =>
          Number(right.exact) - Number(left.exact) ||
          left.regionIds.length - right.regionIds.length ||
          left.extraCharacters - right.extraCharacters ||
          left.start - right.start ||
          left.representation - right.representation,
      )[0]?.regionIds ?? []
    )
  }
  for (const [index, metadata] of metadataValues.entries()) {
    const { value } = metadata
    const regionIds = metadataRegionIds(value)
    outputUnits.push({
      key: `output:metadata:${index}`,
      text: value,
      order: index,
      regionIds,
      provenanced: regionIds.length > 0,
      conservationExempt: metadata.representedByCanonicalNode,
      positionalVisual: false,
    })
  }

  const parent = new Map<string, string>()
  const add = (key: string) => {
    if (!parent.has(key)) parent.set(key, key)
  }
  const find = (key: string): string => {
    const candidate = parent.get(key)
    if (!candidate || candidate === key) return key
    const root = find(candidate)
    parent.set(key, root)
    return root
  }
  const union = (left: string, right: string) => {
    add(left)
    add(right)
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot)
  }
  for (const region of conservedRegions) add(`source:${region.id}`)
  for (const unit of outputUnits) {
    add(unit.key)
    for (const regionId of unit.regionIds) {
      union(unit.key, `source:${regionId}`)
    }
  }

  const components = new Map<
    string,
    { regionIds: string[]; outputs: typeof outputUnits }
  >()
  for (const region of conservedRegions) {
    const root = find(`source:${region.id}`)
    const component = components.get(root) ?? { regionIds: [], outputs: [] }
    component.regionIds.push(region.id)
    components.set(root, component)
  }
  for (const unit of outputUnits) {
    if (unit.conservationExempt) continue
    const root = find(unit.key)
    const component = components.get(root) ?? { regionIds: [], outputs: [] }
    component.outputs.push(unit)
    components.set(root, component)
  }

  let sourceCharacters = 0
  let outputCharacters = 0
  let matchedCharacters = 0
  const missingSourceRegionIds: string[] = []
  const canonicalProseNodeIds = new Set(
    paper.nodes
      .filter(
        (
          node,
        ): node is Extract<ResearchNode, { type: 'heading' | 'paragraph' }> =>
          node.type === 'heading' || node.type === 'paragraph',
      )
      .map((node) => node.id),
  )
  const sameRegionFlowViolationNodeIds = new Set<string>()
  const semanticTextViolationNodeIds = new Set<string>()
  const canonicalTextNodeIds = new Set(
    paper.nodes.filter((node) => node.type !== 'figure').map((node) => node.id),
  )
  for (const component of components.values()) {
    const orderedComponentRegionIds = [...component.regionIds].sort(
      (left, right) =>
        (regionOrder.get(left) ?? 0) - (regionOrder.get(right) ?? 0),
    )
    const orderedComponentOutputs = [...component.outputs].sort(
      (left, right) => left.order - right.order,
    )
    const sourceText = orderedComponentRegionIds
      .map((regionId) => conservedRegionMap.get(regionId)?.text ?? '')
      .join(' ')
    const outputText = orderedComponentOutputs
      .map((unit) => unit.text)
      .join(' ')
    const source = normalizedText(sourceText)
    const output = normalizedText(outputText)
    sourceCharacters += characterCount(source)
    outputCharacters += characterCount(output)
    matchedCharacters +=
      component.outputs.length > 0 &&
      component.outputs.every((unit) => unit.positionalVisual)
        ? occurrenceBoundedMatchedCharacters(source, output)
        : orderedMatchedCharacters(source, output)
    const soleSourceRegion =
      component.regionIds.length === 1
        ? conservedRegionMap.get(component.regionIds[0])
        : undefined
    const canonicalProseOutputs = component.outputs.filter(
      (
        unit,
      ): unit is (typeof outputUnits)[number] & {
        nodeId: string
      } =>
        typeof unit.nodeId === 'string' &&
        canonicalProseNodeIds.has(unit.nodeId),
    )
    const canonicalTextOutputs = component.outputs.filter(
      (
        unit,
      ): unit is (typeof outputUnits)[number] & {
        nodeId: string
      } =>
        typeof unit.nodeId === 'string' &&
        canonicalTextNodeIds.has(unit.nodeId),
    )
    if (
      source.length > 0 &&
      canonicalTextOutputs.length > 0 &&
      canonicalTextOutputs.length === component.outputs.length &&
      meaningPreservingText(
        component.regionIds.length > 1
          ? sourceProvenBoundaryTokenText(
              sourceText,
              hardHyphenLexicon,
              unhyphenatedLexicon,
            )
          : sourceText,
      ) !== meaningPreservingText(outputText)
    ) {
      for (const unit of canonicalTextOutputs) {
        semanticTextViolationNodeIds.add(unit.nodeId)
      }
    }
    if (
      soleSourceRegion &&
      (soleSourceRegion.kind === 'body' ||
        soleSourceRegion.kind === 'spanning') &&
      canonicalProseOutputs.length > 0 &&
      canonicalProseOutputs.length === component.outputs.length &&
      source.normalize('NFKC') !== output.normalize('NFKC')
    ) {
      for (const unit of canonicalProseOutputs) {
        sameRegionFlowViolationNodeIds.add(unit.nodeId)
      }
    }
    if (source && component.outputs.length === 0) {
      missingSourceRegionIds.push(...component.regionIds)
    }
  }

  return {
    sourceCharacters,
    outputCharacters,
    matchedCharacters,
    missingSourceRegionIds: [...new Set(missingSourceRegionIds)],
    sameRegionFlowViolationNodeIds: [...sameRegionFlowViolationNodeIds],
    semanticTextViolationNodeIds: [...semanticTextViolationNodeIds],
    unprovenancedRenderedUnitKeys: outputUnits
      .filter((unit) => !unit.provenanced)
      .map((unit) => unit.key),
  }
}

export function classifyStructuralLineBoundaryDecisions({
  decisions,
  paper,
  provenance,
  visualRelationships,
  assets,
  regions,
}: {
  decisions: PdfLineBoundaryDecision[]
  paper: ResearchPaper
  provenance?: Record<string, NodeSourceEvidence>
  visualRelationships?: PdfVisualRelationship[]
  assets?: PdfVisualAsset[]
  regions?: readonly PdfPageRegion[]
}) {
  const validatedRelationships = validatedPdfVisualRelationships({
    paper,
    provenance,
    relationships: visualRelationships,
    assets,
    regions,
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
        : ('unresolved' as const),
      evidence: isStructural
        ? [...new Set([...retainedEvidence, structuralEvidence])]
        : retainedEvidence,
    }
  })
  return {
    decisions: classified,
    unresolvedCorruptingJoinCount: classified.filter(
      (decision) => decision.outcome === 'unresolved',
    ).length,
    structurallyConsumedLineBoundaryCount: classified.filter(
      (decision) => decision.outcome === 'structural-boundary',
    ).length,
  }
}

function validateLineBoundaryLedger(
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
    (decision) => decision.outcome === 'unresolved',
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

function pageLines(page: PdfPageAnalysis) {
  return groupRunsIntoLines(page)
}

function scholarlyCaptionKind(value: string) {
  return (
    parsePdfScholarlyVisualLabel(value, { context: 'caption' })?.kind ?? null
  )
}

export function detectPdfSemanticSignals(
  pages: PdfPageAnalysis[],
  suppliedRegions?: PdfPageRegion[],
  suppliedLineBoundaryDecisions?: readonly PdfLineBoundaryDecision[],
): PdfSemanticSignals {
  const reconstructed = suppliedRegions ? null : reconstructPageRegions(pages)
  const regions = suppliedRegions ?? reconstructed!.regions
  const lineBoundaryDecisions =
    suppliedLineBoundaryDecisions ?? reconstructed?.lineBoundaryDecisions ?? []
  const markerResult = classifyPdfNoteMarkers(
    regions,
    undefined,
    lineBoundaryDecisions,
  )
  const captionFigures = regions.filter(
    (region) =>
      region.kind === 'caption' &&
      scholarlyCaptionKind(region.text) === 'figure',
  ).length
  const signals: PdfSemanticSignals = {
    // Once region reconstruction is available, a figure obligation requires
    // the same caption-region proof as tables. Counting raw PDF lines here
    // double-counts a split caption (or incidental "Figure:" text) and makes
    // an otherwise complete visual graph fail closed.
    captions: suppliedRegions ? captionFigures : 0,
    tables: regions.filter(
      (region) =>
        region.kind === 'caption' &&
        scholarlyCaptionKind(region.text) === 'table',
    ).length,
    equations: 0,
    citations: markerResult.classifications.filter(
      (classification) => classification.disposition === 'citation',
    ).length,
    footnoteReferences: markerResult.classifications.filter(
      (classification) => classification.disposition === 'note-reference',
    ).length,
    footnotes: markerResult.noteBodyRegionIds.length,
  }
  for (const page of pages) {
    for (const line of pageLines(page)) {
      if (!suppliedRegions && scholarlyCaptionKind(line.text) === 'figure') {
        signals.captions += 1
      }
      if (/(?:^|\b)(?:equation|eq\.?)\s*\(?\d+\)?/i.test(line.text)) {
        signals.equations += 1
      }
    }
  }
  signals.equations = Math.max(
    signals.equations,
    regions.filter(isProbableDisplayEquation).length,
  )
  return signals
}

function coverage(resolved: number, expected: number) {
  return expected === 0 ? 1 : rounded(Math.min(resolved / expected, 1))
}

function normalizedEquationTranscript(value: string) {
  return value.normalize('NFC').replace(/\s+/gu, '')
}

function sourceBoxArea(box: NormalizedSourceBox) {
  return Math.max(0, box.width) * Math.max(0, box.height)
}

function sourceBoxIntersectionArea(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  if (left.page !== right.page) return 0
  return (
    Math.max(
      0,
      Math.min(left.x + left.width, right.x + right.width) -
        Math.max(left.x, right.x),
    ) *
    Math.max(
      0,
      Math.min(left.y + left.height, right.y + right.height) -
        Math.max(left.y, right.y),
    )
  )
}

function materiallyOverlappingSourceBoxes(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  const smallerArea = Math.min(sourceBoxArea(left), sourceBoxArea(right))
  return (
    smallerArea > 0 &&
    sourceBoxIntersectionArea(left, right) / smallerArea >= 0.35
  )
}

function printedEquationOrdinal(region: PdfPageRegion) {
  return (
    region.text
      .match(/(?:^|\s)\(\s*(\d+[a-z]?)\s*\)(?:\s|$)/iu)?.[1]
      ?.toLowerCase() ?? null
  )
}

function geometricallyAssociatedEquationRegion(
  source: PdfPageRegion,
  candidate: PdfPageRegion,
) {
  if (
    source.page !== candidate.page ||
    candidate.lines.length === 0 ||
    (candidate.kind !== 'equation' && !isProbableDisplayEquation(candidate))
  ) {
    return false
  }
  const sourceOrdinal = printedEquationOrdinal(source)
  const candidateOrdinal = printedEquationOrdinal(candidate)
  if (sourceOrdinal && candidateOrdinal && sourceOrdinal !== candidateOrdinal) {
    return false
  }
  const horizontalGap = Math.max(
    source.box.x - (candidate.box.x + candidate.box.width),
    candidate.box.x - (source.box.x + source.box.width),
    0,
  )
  const verticalGap = Math.max(
    source.box.y - (candidate.box.y + candidate.box.height),
    candidate.box.y - (source.box.y + source.box.height),
    0,
  )
  const horizontalOverlap = Math.max(
    0,
    Math.min(
      source.box.x + source.box.width,
      candidate.box.x + candidate.box.width,
    ) - Math.max(source.box.x, candidate.box.x),
  )
  const verticalOverlap = Math.max(
    0,
    Math.min(
      source.box.y + source.box.height,
      candidate.box.y + candidate.box.height,
    ) - Math.max(source.box.y, candidate.box.y),
  )
  const minimumWidth = Math.min(source.box.width, candidate.box.width)
  const minimumHeight = Math.min(source.box.height, candidate.box.height)
  return (
    (horizontalOverlap >= minimumWidth * 0.25 &&
      verticalGap <= Math.max(0.012, minimumHeight * 0.8)) ||
    (verticalOverlap >= minimumHeight * 0.25 && horizontalGap <= 0.025)
  )
}

export function hasResolvedEquationTranscript(
  relationship: PdfVisualRelationship,
  regions: readonly PdfPageRegion[] | undefined,
  pages: readonly PdfPageAnalysis[] = [],
  adjudicationContext?: EquationTranscriptContext,
) {
  const ownerAdjudicated = Boolean(
    adjudicationContext &&
    verifyEquationTranscriptAdjudication(adjudicationContext, relationship.id),
  )
  if (
    relationship.kind !== 'equation' ||
    relationship.status !== 'matched' ||
    relationship.sourceText.trim().length === 0 ||
    (relationship.evidence.includes('source-text-transcript-unresolved') &&
      !ownerAdjudicated) ||
    !regions ||
    relationship.sourceRegionIds.length === 0 ||
    !relationship.sourceLineIds?.length ||
    new Set(relationship.sourceRegionIds).size !==
      relationship.sourceRegionIds.length ||
    new Set(relationship.sourceLineIds).size !==
      relationship.sourceLineIds.length
  ) {
    return false
  }

  const regionOccurrences = new Map<string, PdfPageRegion[]>()
  for (const region of regions) {
    const occurrences = regionOccurrences.get(region.id) ?? []
    occurrences.push(region)
    regionOccurrences.set(region.id, occurrences)
  }
  const scopedRegions = relationship.sourceRegionIds.flatMap(
    (regionId) => regionOccurrences.get(regionId) ?? [],
  )
  if (
    scopedRegions.length !== relationship.sourceRegionIds.length ||
    relationship.sourceRegionIds.some(
      (regionId) => regionOccurrences.get(regionId)?.length !== 1,
    )
  ) {
    return false
  }
  if (
    hasUnprovedTwoDimensionalEquationTranscript(scopedRegions) &&
    !ownerAdjudicated
  ) {
    return false
  }

  const lineOccurrences = new Map<
    string,
    Array<{ regionId: string; line: PdfPageRegion['lines'][number] }>
  >()
  for (const region of scopedRegions as PdfPageRegion[]) {
    for (const line of region.lines) {
      const occurrences = lineOccurrences.get(line.id) ?? []
      occurrences.push({ regionId: region.id, line })
      lineOccurrences.set(line.id, occurrences)
    }
  }
  const selectedLines = relationship.sourceLineIds.flatMap(
    (lineId) => lineOccurrences.get(lineId) ?? [],
  )
  const expectedLineIds = scopedRegions.flatMap((region) =>
    region.lines.map((line) => line.id),
  )
  if (
    selectedLines.length !== relationship.sourceLineIds.length ||
    expectedLineIds.length !== relationship.sourceLineIds.length ||
    expectedLineIds.some(
      (lineId) => !relationship.sourceLineIds!.includes(lineId),
    ) ||
    relationship.sourceLineIds.some(
      (lineId) => lineOccurrences.get(lineId)?.length !== 1,
    )
  ) {
    return false
  }

  const scopedRegionIds = new Set(relationship.sourceRegionIds)
  const textualSourceRegions = scopedRegions.filter(
    (region) => region.lines.length > 0,
  )
  const missesAssociatedRegion = regions.some(
    (candidate) =>
      !scopedRegionIds.has(candidate.id) &&
      textualSourceRegions.some((source) =>
        geometricallyAssociatedEquationRegion(source, candidate),
      ),
  )
  if (missesAssociatedRegion) return false

  const claimedObjectIds = new Set(relationship.sourceObjectIds)
  const decorativeObjectIds = decorativeNativeObjectIds([...pages])
  const missesAssociatedObject = pages.some((page) =>
    (page.objects ?? []).some(
      (object) =>
        object.role !== 'scan-source' &&
        !decorativeObjectIds.has(object.id) &&
        textualSourceRegions.some((source) =>
          materiallyOverlappingSourceBoxes(source.box, object.box),
        ) &&
        !claimedObjectIds.has(object.id),
    ),
  )
  if (missesAssociatedObject) return false

  const missesAssociatedObjectRegion = regions.some(
    (candidate) =>
      candidate.nativeObjectIds.length > 0 &&
      candidate.nativeObjectIds.some((objectId) =>
        claimedObjectIds.has(objectId),
      ) &&
      !scopedRegionIds.has(candidate.id) &&
      textualSourceRegions.some((source) =>
        materiallyOverlappingSourceBoxes(source.box, candidate.box),
      ),
  )
  if (missesAssociatedObjectRegion) return false

  const completeSourceText = selectedLines
    .sort(
      (left, right) =>
        left.line.box.page - right.line.box.page ||
        left.line.box.y - right.line.box.y ||
        left.line.box.x - right.line.box.x ||
        left.line.id.localeCompare(right.line.id),
    )
    .map(({ line }) => line.text)
    .join(' ')
  return (
    ownerAdjudicated ||
    (normalizedEquationTranscript(completeSourceText).length > 0 &&
      normalizedEquationTranscript(relationship.sourceText) ===
        normalizedEquationTranscript(completeSourceText))
  )
}

function relationshipCounts(
  paper: ResearchPaper,
  signals: PdfSemanticSignals,
  pages: readonly PdfPageAnalysis[],
  visualRelationships?: PdfVisualRelationship[],
  citationRelationships?: PdfCitationRelationship[],
  provenance?: Record<string, NodeSourceEvidence>,
  assets: PdfVisualAsset[] = [],
  regions?: readonly PdfPageRegion[],
  equationTranscriptContext?: EquationTranscriptContext,
) {
  const nodesById = new Map(paper.nodes.map((node) => [node.id, node]))
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]))
  const captions = new Set(
    paper.nodes
      .filter((node) => node.type === 'caption')
      .map((node) => node.id),
  )
  const resolvedCaptions = visualRelationships
    ? visualRelationships.filter(
        (relationship) =>
          relationship.kind === 'figure' && relationship.status === 'matched',
      ).length
    : new Set(
        paper.nodes
          .filter(
            (node): node is Extract<ResearchNode, { type: 'figure' }> =>
              node.type === 'figure' &&
              captions.has(node.relationships.caption),
          )
          .map((node) => node.relationships.caption),
      ).size
  const resolvedTableRelationships =
    visualRelationships?.filter((relationship) => {
      if (
        relationship.kind !== 'table' ||
        relationship.status !== 'matched' ||
        !relationship.canonicalNodeId
      ) {
        return false
      }
      const node = nodesById.get(relationship.canonicalNodeId)
      return (
        node?.type === 'figure' &&
        node.objectType === 'table' &&
        relationship.assetIds.some((assetId) => {
          const asset = assetsById.get(assetId)
          if (
            !node.relationships.assets?.includes(assetId) ||
            asset?.kind !== 'table'
          ) {
            return false
          }
          const semanticGrid =
            asset.mediaType === 'application/xhtml+xml' &&
            asset.rendition === 'semantic-table' &&
            isStrictSemanticTable(node.table)
          const exactSourceCrop =
            asset.mediaType === 'image/png' &&
            asset.rendition === 'source-page-crop' &&
            node.table === undefined &&
            Boolean(asset.sourceCropBox) &&
            Boolean(relationship.sourceLineIds?.length) &&
            relationship.sourceText.trim().length > 0 &&
            relationship.evidence.includes('source-page-crop') &&
            relationship.evidence.some((item) =>
              [
                'bounded-table-scope',
                'complete-bounded-table-scope',
                'detected-table-geometry',
              ].includes(item),
            )
          return semanticGrid || exactSourceCrop
        })
      )
    }) ?? []
  const resolvedTables = resolvedTableRelationships.length
  const resolvedSemanticTables = resolvedTableRelationships.filter(
    (relationship) => {
      const node = nodesById.get(relationship.canonicalNodeId!)
      return (
        node?.type === 'figure' &&
        node.objectType === 'table' &&
        isStrictSemanticTable(node.table) &&
        relationship.assetIds.some((assetId) => {
          const asset = assetsById.get(assetId)
          return (
            asset?.kind === 'table' &&
            asset.mediaType === 'application/xhtml+xml' &&
            asset.rendition === 'semantic-table'
          )
        })
      )
    },
  ).length
  const resolvedEquations =
    visualRelationships?.filter((relationship) =>
      hasResolvedEquationTranscript(
        relationship,
        regions,
        pages,
        equationTranscriptContext,
      ),
    ).length ?? 0
  const noteIds = new Set(
    paper.nodes
      .filter((node) => node.type === 'footnote')
      .map((node) => node.id),
  )
  const noteReferences = [
    ...(paper.authorNotes ?? []),
    ...paper.nodes.flatMap((node) =>
      'noteReferences' in node && node.noteReferences
        ? node.noteReferences
        : [],
    ),
  ]
  const resolvedNoteReferences = noteReferences.filter((reference) =>
    noteIds.has(reference.target),
  )
  const resolvedNotes = new Set(
    resolvedNoteReferences.map((reference) => reference.target),
  )
  const resolvedCitations = (citationRelationships ?? []).filter(
    (relationship) => {
      const anchor = relationship.canonicalAnchor
      if (
        relationship.status !== 'matched' ||
        relationship.targetNodeIds.length !== relationship.labels.length ||
        !anchor
      ) {
        return false
      }
      const node = nodesById.get(anchor.nodeId)
      const anchorText =
        node?.type === 'figure'
          ? (node.sourceText ?? '')
          : node && 'text' in node
            ? node.text
            : ''
      if (
        !node ||
        (node.type !== 'heading' &&
          node.type !== 'paragraph' &&
          node.type !== 'quote' &&
          !(
            node.type === 'figure' &&
            node.objectType === 'table' &&
            node.sourceText
          )) ||
        anchor.start < 0 ||
        anchor.start >= anchor.end ||
        anchor.end > anchorText.length ||
        !relationship.targetNodeIds.every((targetId) => {
          const target = nodesById.get(targetId)
          return (
            target?.type === 'paragraph' &&
            target.list?.numberingId === 'references'
          )
        }) ||
        !provenance?.[node.id]?.regionIds.includes(
          relationship.referenceRegionId,
        )
      ) {
        return false
      }
      return Boolean(
        node.inlineRuns?.some(
          (run) =>
            run.relationshipId === relationship.id &&
            run.semanticRole === 'citation' &&
            run.start === anchor.start &&
            run.end === anchor.end &&
            run.targetIds?.length === relationship.targetNodeIds.length &&
            run.targetIds.every(
              (targetId, index) =>
                targetId === relationship.targetNodeIds[index],
            ),
        ),
      )
    },
  ).length
  return {
    expected:
      signals.captions +
      signals.tables +
      signals.equations +
      signals.citations +
      signals.footnoteReferences,
    resolved:
      Math.min(resolvedCaptions, signals.captions) +
      Math.min(resolvedTables, signals.tables) +
      Math.min(resolvedEquations, signals.equations) +
      Math.min(resolvedCitations, signals.citations) +
      Math.min(resolvedNoteReferences.length, signals.footnoteReferences),
    resolvedCaptions: Math.min(resolvedCaptions, signals.captions),
    resolvedTables: Math.min(resolvedTables, signals.tables),
    resolvedSemanticTables: Math.min(resolvedSemanticTables, signals.tables),
    resolvedEquations: Math.min(resolvedEquations, signals.equations),
    resolvedCitations: Math.min(resolvedCitations, signals.citations),
    resolvedNoteReferences: Math.min(
      resolvedNoteReferences.length,
      signals.footnoteReferences,
    ),
    resolvedNotes: Math.min(resolvedNotes.size, signals.footnotes),
  }
}

function readingOrderDiagnosticCount(diagnostics: ReconstructionDiagnostic[]) {
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.code === 'LOW_CONFIDENCE_BLOCK' ||
      diagnostic.code === 'AMBIGUOUS_READING_ORDER',
  ).length
}

function boxesConnected(left: NormalizedSourceBox, right: NormalizedSourceBox) {
  if (left.page !== right.page) return false
  const horizontalGap = Math.max(
    left.x - (right.x + right.width),
    right.x - (left.x + left.width),
    0,
  )
  const verticalGap = Math.max(
    left.y - (right.y + right.height),
    right.y - (left.y + left.height),
    0,
  )
  return (
    (verticalGap === 0 && horizontalGap <= 0.04) ||
    (horizontalGap === 0 && verticalGap <= 0.04)
  )
}

function connectedVisualComponentCount(boxes: NormalizedSourceBox[]) {
  const remaining = boxes.map((box) => ({ ...box }))
  let count = 0
  while (remaining.length > 0) {
    const component = [remaining.shift()!]
    for (let index = 0; index < remaining.length;) {
      if (
        component.some((candidate) =>
          boxesConnected(candidate, remaining[index]),
        )
      ) {
        component.push(remaining.splice(index, 1)[0])
        index = 0
      } else {
        index += 1
      }
    }
    count += 1
  }
  return count
}

function semanticAssetCounts({
  pages,
  semanticSignals,
  visualRelationships,
  validatedVisualRelationships,
}: {
  pages: PdfPageAnalysis[]
  semanticSignals: PdfSemanticSignals
  visualRelationships?: PdfVisualRelationship[]
  validatedVisualRelationships: PdfVisualRelationship[]
}) {
  const relationships = visualRelationships ?? []
  const claimedObjectIds = new Set(
    relationships.flatMap((relationship) => [
      ...relationship.sourceObjectIds,
      ...relationship.candidates.flatMap(
        (candidate) => candidate.sourceObjectIds,
      ),
    ]),
  )
  const decorativeObjectIds = decorativeNativeObjectIds(pages)
  const orphanBoxes = pages.flatMap((page) =>
    (page.objects ?? [])
      .filter(
        (object) =>
          object.role !== 'scan-source' &&
          !decorativeObjectIds.has(object.id) &&
          !claimedObjectIds.has(object.id),
      )
      .map((object) => object.box),
  )
  const unboundedImagePages = pages.filter((page) => {
    const extractedImageCount = (page.objects ?? []).filter(
      (object) => object.kind === 'image',
    ).length
    if (page.imageCount <= extractedImageCount) return false
    const pageSignals = detectPdfSemanticSignals([page])
    const relationshipOnPage = relationships.some((relationship) =>
      relationship.sourceBoxes.some((box) => box.page === page.page),
    )
    return (
      !relationshipOnPage &&
      pageSignals.captions + pageSignals.tables + pageSignals.equations === 0
    )
  }).length
  const detectedSemanticVisuals = Math.max(
    relationships.length,
    semanticSignals.captions,
    semanticSignals.tables + semanticSignals.equations,
  )
  const sourceAssetCount =
    detectedSemanticVisuals +
    connectedVisualComponentCount(orphanBoxes) +
    unboundedImagePages
  return {
    sourceAssetCount,
    exportedAssetCount: validatedVisualRelationships.length,
  }
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u

function validUnitSourceBox(
  box: NormalizedSourceBox,
  page: PdfPageAnalysis,
  method: NormalizedSourceBox['method'],
) {
  const tolerance = 0.00001
  return (
    box.page === page.page &&
    box.rotation === page.rotation &&
    box.method === method &&
    [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.width > 0 &&
    box.height > 0 &&
    box.x + box.width <= 1 + tolerance &&
    box.y + box.height <= 1 + tolerance
  )
}

function sameSourceBox(left: NormalizedSourceBox, right: NormalizedSourceBox) {
  return (
    left.page === right.page &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.rotation === right.rotation &&
    left.method === right.method
  )
}

function sourceBoxOverlapRatio(
  left: Pick<NormalizedSourceBox, 'x' | 'y' | 'width' | 'height'>,
  right: Pick<NormalizedSourceBox, 'x' | 'y' | 'width' | 'height'>,
) {
  const intersectionWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  )
  const intersectionHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  )
  const smallerArea = Math.min(
    Math.max(0, left.width) * Math.max(0, left.height),
    Math.max(0, right.width) * Math.max(0, right.height),
  )
  return smallerArea > 0
    ? (intersectionWidth * intersectionHeight) / smallerArea
    : 0
}

function duplicateOcrTextMatchesEmbedded(
  embeddedText: string,
  duplicateText: string,
) {
  const duplicate = normalizedText(duplicateText)
  const embeddedTokens =
    embeddedText
      .normalize('NFKC')
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.map(normalizedText) ?? []
  return (
    duplicate.length > 0 &&
    (normalizedText(embeddedText) === duplicate ||
      embeddedTokens.includes(duplicate))
  )
}

function hasVerifiedEmbeddedOnlyOcrConfirmation(
  page: PdfPageAnalysis,
  expectedSourceSha256?: string,
) {
  const ocr = page.ocr
  const embeddedRuns = page.runs.filter(
    (run) =>
      run.method === 'pdf-text' &&
      run.text.trim() &&
      validUnitSourceBox(run, page, 'pdf-text'),
  )
  if (
    page.kind !== 'ocr-complete' ||
    page.imageCount !== 0 ||
    (page.objects?.length ?? 0) !== 0 ||
    page.runs.some((run) => run.method === 'ocr') ||
    embeddedRuns.length === 0 ||
    !ocr ||
    !ocr.engine.trim() ||
    !ocr.engineVersion.trim() ||
    !ocr.model.trim() ||
    !ocr.modelVersion.trim() ||
    ocr.languages.length === 0 ||
    ocr.languages.some((language) => !language.trim()) ||
    !SHA256_HEX_PATTERN.test(ocr.sourceSha256) ||
    !SHA256_HEX_PATTERN.test(ocr.rasterSha256) ||
    (expectedSourceSha256 !== undefined &&
      ocr.sourceSha256 !== expectedSourceSha256) ||
    !Number.isFinite(ocr.confidence) ||
    ocr.confidence < 0.75 ||
    ocr.confidence > 1 ||
    ocr.words.length === 0 ||
    ocr.words.some(
      (word) =>
        word.mergeStatus !== 'duplicate' ||
        !word.text.trim() ||
        !word.lineId.trim() ||
        !Number.isFinite(word.confidence) ||
        word.confidence < 0 ||
        word.confidence > 1 ||
        !validUnitSourceBox(word.box, page, 'ocr'),
    ) ||
    new Set(ocr.lines.map((line) => line.id)).size !== ocr.lines.length ||
    ocr.lines.some(
      (line) =>
        !line.id.trim() ||
        !line.text.trim() ||
        !Number.isFinite(line.confidence) ||
        line.confidence < 0 ||
        line.confidence > 1 ||
        !validUnitSourceBox(line.box, page, 'ocr'),
    )
  ) {
    return false
  }
  const lineIds = new Set(ocr.lines.map((line) => line.id))
  if (lineIds.size > 0 && ocr.words.some((word) => !lineIds.has(word.lineId))) {
    return false
  }
  const matchingRuns = (word: NonNullable<typeof ocr>['words'][number]) =>
    embeddedRuns.filter(
      (run) =>
        sourceBoxOverlapRatio(run, word.box) >= 0.55 &&
        duplicateOcrTextMatchesEmbedded(run.text, word.text),
    )
  return (
    ocr.words.every((word) => matchingRuns(word).length > 0) &&
    embeddedRuns.every((run) =>
      ocr.words.some(
        (word) =>
          sourceBoxOverlapRatio(run, word.box) >= 0.55 &&
          duplicateOcrTextMatchesEmbedded(run.text, word.text),
      ),
    )
  )
}

function hasSubstantiveOcrEvidence(
  page: PdfPageAnalysis,
  expectedSourceSha256?: string,
) {
  const ocr = page.ocr
  if (
    !ocr ||
    !ocr.engine.trim() ||
    !ocr.engineVersion.trim() ||
    !ocr.model.trim() ||
    !ocr.modelVersion.trim() ||
    ocr.languages.length === 0 ||
    ocr.languages.some((language) => !language.trim()) ||
    !SHA256_HEX_PATTERN.test(ocr.sourceSha256) ||
    !SHA256_HEX_PATTERN.test(ocr.rasterSha256) ||
    (expectedSourceSha256 !== undefined &&
      ocr.sourceSha256 !== expectedSourceSha256) ||
    !Number.isFinite(ocr.confidence) ||
    ocr.confidence < 0.75 ||
    ocr.confidence > 1 ||
    ocr.lines.length === 0 ||
    new Set(ocr.lines.map((line) => line.id)).size !== ocr.lines.length
  ) {
    return false
  }
  const linesById = new Map(ocr.lines.map((line) => [line.id, line]))
  if (
    ocr.lines.some(
      (line) =>
        !line.id.trim() ||
        !line.text.trim() ||
        !Number.isFinite(line.confidence) ||
        line.confidence < 0 ||
        line.confidence > 1 ||
        !validUnitSourceBox(line.box, page, 'ocr'),
    ) ||
    ocr.words.some(
      (word) =>
        !word.text.trim() ||
        !word.lineId.trim() ||
        !linesById.has(word.lineId) ||
        !Number.isFinite(word.confidence) ||
        word.confidence < 0 ||
        word.confidence > 1 ||
        !validUnitSourceBox(word.box, page, 'ocr'),
    )
  ) {
    return false
  }
  const acceptedWords = ocr.words.filter(
    (word) => word.mergeStatus === 'accepted',
  )
  if (acceptedWords.length === 0) return false
  const recoveredRuns = page.runs.filter(
    (run) =>
      run.method === 'ocr' &&
      run.text.trim() &&
      validUnitSourceBox(run, page, 'ocr'),
  )
  return acceptedWords.every((word) =>
    recoveredRuns.some(
      (run) => run.text === word.text.trim() && sameSourceBox(run, word.box),
    ),
  )
}

function mixedPageHasCompleteSemanticVisualCoverage({
  page,
  pages,
  regions,
  validatedVisualRelationships,
  equationTranscriptContext,
}: {
  page: PdfPageAnalysis
  pages: readonly PdfPageAnalysis[]
  regions: readonly PdfPageRegion[]
  validatedVisualRelationships: readonly PdfVisualRelationship[]
  equationTranscriptContext: EquationTranscriptContext
}) {
  const objects = page.objects ?? []
  const decorativeObjectIds = decorativeNativeObjectIds([...pages])
  const semanticObjects = objects.filter(
    (object) =>
      object.role !== 'scan-source' && !decorativeObjectIds.has(object.id),
  )
  if (
    objects.some((object) => object.role === 'scan-source') ||
    semanticObjects.length === 0 ||
    page.imageCount > objects.filter((object) => object.kind === 'image').length
  ) {
    return false
  }
  const claimedObjectIds = new Set(
    validatedVisualRelationships.flatMap((relationship) => {
      if (
        !relationship.sourceBoxes.some((box) => box.page === page.page) ||
        (relationship.kind === 'equation' &&
          !hasResolvedEquationTranscript(
            relationship,
            regions,
            pages,
            equationTranscriptContext,
          ))
      ) {
        return []
      }
      return relationship.sourceObjectIds
    }),
  )
  return semanticObjects.every((object) => claimedObjectIds.has(object.id))
}

export function assessPdfCompleteness({
  pages,
  paper,
  diagnostics,
  readingOrder,
  regions,
  visualRelationships,
  assets,
  citationRelationships,
  noteRelationships,
  policy = DEFAULT_PDF_COMPLETENESS_POLICY,
  reclassifiedNoteReferenceCount = 0,
  reclassifiedCitationCount = 0,
  lineBoundaryDecisions,
  unresolvedCorruptingJoinCount,
  structurallyConsumedLineBoundaryCount,
  provenance,
  inlineSpanLedger = { expected: 0, mapped: 0 },
  hyperlinkLedger = { expected: 0, mapped: 0 },
  sourceSha256,
  canonicalFloatScopes = [],
}: QualityInput): {
  semanticSignals: PdfSemanticSignals
  completeness: PdfCompletenessMetrics
  diagnostics: ReconstructionDiagnostic[]
  readiness: PdfReadiness
} {
  const semanticSignals = detectPdfSemanticSignals(
    pages,
    regions,
    lineBoundaryDecisions,
  )
  semanticSignals.equations = Math.max(
    semanticSignals.equations,
    new Set(
      (visualRelationships ?? [])
        .filter((relationship) => relationship.kind === 'equation')
        .map((relationship) => relationship.id),
    ).size,
  )
  semanticSignals.footnoteReferences = Math.max(
    semanticSignals.footnoteReferences - reclassifiedNoteReferenceCount,
    0,
  )
  semanticSignals.citations += reclassifiedCitationCount
  const validatedVisualRelationships = validatedPdfVisualRelationships({
    paper,
    provenance,
    relationships: visualRelationships,
    assets,
    regions,
  })
  const allSourceRegions = regions ?? []
  const equationTranscriptContext: EquationTranscriptContext = {
    paper,
    pages,
    regions: allSourceRegions,
    visualRelationships: visualRelationships ?? [],
    assets: assets ?? [],
  }
  const regionMap = new Map(
    allSourceRegions.map((region) => [region.id, region]),
  )
  const orderedSourceRegions = readingOrder
    ? readingOrder.order
        .map((id) => regionMap.get(id))
        .filter((region): region is PdfPageRegion => Boolean(region))
    : []
  const sourceText = normalizedText(
    orderedSourceRegions.length > 0
      ? orderedSourceRegions.map((region) => region.text).join(' ')
      : pages
          .flatMap((page) => page.runs)
          .map((run) => run.text)
          .join(' '),
  )
  const validatedVisualRepresentation = validatedVisualRepresentationByNode(
    paper,
    provenance,
    validatedVisualRelationships,
    assets,
    allSourceRegions,
  )
  const outputText = normalizedText(
    paper.nodes
      .map((node) =>
        nodeText(node, validatedVisualRepresentation.textByNode.get(node.id)),
      )
      .filter(Boolean)
      .join(' '),
  )
  const fallbackMatchedTextCharacters = orderedMatchedCharacters(
    sourceText,
    outputText,
  )
  const conservedText =
    orderedSourceRegions.length > 0 && provenance
      ? provenanceTextConservation({
          allRegions: allSourceRegions,
          orderedRegions: orderedSourceRegions,
          paper,
          provenance,
          visualRelationships: validatedVisualRelationships,
          assets,
          lineBoundaryDecisions: lineBoundaryDecisions ?? [],
        })
      : {
          sourceCharacters: characterCount(sourceText),
          outputCharacters: characterCount(outputText),
          matchedCharacters: fallbackMatchedTextCharacters,
          missingSourceRegionIds: [],
          sameRegionFlowViolationNodeIds: [],
          semanticTextViolationNodeIds: [],
          unprovenancedRenderedUnitKeys: [],
        }
  const matchedTextCharacters = conservedText.matchedCharacters
  const duplicateSpans = duplicateCanonicalSpanCount(sourceText, paper)
  const classifiedLineBoundaries = classifyStructuralLineBoundaryDecisions({
    decisions: lineBoundaryDecisions ?? [],
    paper,
    provenance,
    visualRelationships,
    assets,
    regions: allSourceRegions,
  })
  const lineLedger = validateLineBoundaryLedger(
    regions,
    lineBoundaryDecisions ? classifiedLineBoundaries.decisions : undefined,
    unresolvedCorruptingJoinCount,
    structurallyConsumedLineBoundaryCount,
  )
  const { sourceAssetCount, exportedAssetCount } = semanticAssetCounts({
    pages,
    semanticSignals,
    visualRelationships,
    validatedVisualRelationships,
  })
  const relationships = relationshipCounts(
    paper,
    semanticSignals,
    pages,
    visualRelationships === undefined
      ? undefined
      : validatedVisualRelationships,
    citationRelationships,
    provenance,
    assets,
    regions,
    equationTranscriptContext,
  )
  const unresolvedObjects = {
    assets: Math.max(sourceAssetCount - exportedAssetCount, 0),
    captions: Math.max(
      semanticSignals.captions - relationships.resolvedCaptions,
      0,
    ),
    tables: Math.max(semanticSignals.tables - relationships.resolvedTables, 0),
    equations: Math.max(
      semanticSignals.equations - relationships.resolvedEquations,
      0,
    ),
    citations: Math.max(
      semanticSignals.citations - relationships.resolvedCitations,
      0,
    ),
    footnoteReferences: Math.max(
      semanticSignals.footnoteReferences - relationships.resolvedNoteReferences,
      0,
    ),
    footnotes: Math.max(
      semanticSignals.footnotes - relationships.resolvedNotes,
      0,
    ),
  }
  const unresolvedObjectCount = Object.values(unresolvedObjects).reduce(
    (total, count) => total + count,
    0,
  )
  const flowOrderViolationNodeIds = [
    ...new Set([
      ...canonicalFlowOrderViolationNodeIds(
        paper,
        provenance,
        orderedSourceRegions,
        canonicalFloatScopes,
      ),
      ...conservedText.sameRegionFlowViolationNodeIds,
      ...conservedText.semanticTextViolationNodeIds,
      ...unprovedInlineMathAtomNodeIds({
        paper,
        provenance,
        regions: allSourceRegions,
      }),
    ]),
  ]
  const visualOrderViolationRelationshipIds =
    canonicalVisualOrderViolationRelationshipIds(
      paper,
      validatedVisualRelationships,
      readingOrder,
    )
  const readingOrderDiagnostics =
    readingOrderDiagnosticCount(diagnostics) +
    (flowOrderViolationNodeIds.length > 0 ? 1 : 0) +
    (visualOrderViolationRelationshipIds.length > 0 ? 1 : 0)
  const sourceReadingOrderEvaluation =
    readingOrder?.evaluation ??
    ({
      schemaVersion: '1.0.0',
      algorithm: 'deterministic-geometry-v1',
      mode: 'deterministic-only',
      regionCount: 0,
      acceptedEdgeCount: 0,
      unresolvedEdgeCount: 0,
      cycleRate: 0,
      orderAccuracy: null,
      provider: null,
      modelVersion: null,
      latencyMs: 0,
      costUsd: 0,
      reviewRequired: false,
    } as const)
  const readingOrderEvaluation = {
    ...sourceReadingOrderEvaluation,
    reviewRequired:
      sourceReadingOrderEvaluation.reviewRequired ||
      readingOrderDiagnostics > 0,
  }
  const ocrRequiredPages = pages
    .filter((page) => {
      if (page.kind === 'born-digital') return false
      const substantiveOcr =
        hasSubstantiveOcrEvidence(page, sourceSha256) ||
        hasVerifiedEmbeddedOnlyOcrConfirmation(page, sourceSha256)
      if (page.kind === 'ocr-complete') return !substantiveOcr
      if (page.kind === 'ocr-required') return true
      return (
        !substantiveOcr &&
        !mixedPageHasCompleteSemanticVisualCoverage({
          page,
          pages,
          regions: allSourceRegions,
          validatedVisualRelationships,
          equationTranscriptContext,
        })
      )
    })
    .map((page) => page.page)
  const completeness: PdfCompletenessMetrics = {
    sourceTextCharacters: conservedText.sourceCharacters,
    outputTextCharacters: conservedText.outputCharacters,
    matchedTextCharacters,
    textCoverage: Math.min(
      coverage(matchedTextCharacters, conservedText.sourceCharacters),
      coverage(matchedTextCharacters, conservedText.outputCharacters),
    ),
    duplicateCanonicalSpanCount: duplicateSpans,
    missingSourceRegionCount: conservedText.missingSourceRegionIds.length,
    unprovenancedRenderedUnitCount:
      conservedText.unprovenancedRenderedUnitKeys.length,
    expectedInlineSpanCount: inlineSpanLedger.expected,
    mappedInlineSpanCount: inlineSpanLedger.mapped,
    inlineSpanCoverage: coverage(
      inlineSpanLedger.mapped,
      inlineSpanLedger.expected,
    ),
    expectedHyperlinkCount: hyperlinkLedger.expected,
    mappedHyperlinkCount: hyperlinkLedger.mapped,
    hyperlinkCoverage: coverage(
      hyperlinkLedger.mapped,
      hyperlinkLedger.expected,
    ),
    lineBoundaryCount: lineLedger.expected,
    decidedLineBoundaryCount: lineLedger.decided,
    unresolvedCorruptingJoinCount: lineLedger.unresolved,
    structurallyConsumedLineBoundaryCount: lineLedger.structurallyConsumed,
    sourceAssetCount,
    exportedAssetCount,
    assetCoverage: coverage(exportedAssetCount, sourceAssetCount),
    expectedRelationshipCount: relationships.expected,
    resolvedRelationshipCount: relationships.resolved,
    relationshipCoverage: coverage(
      relationships.resolved,
      relationships.expected,
    ),
    expectedSemanticTableCount: semanticSignals.tables,
    resolvedSemanticTableCount: relationships.resolvedSemanticTables,
    semanticTableCoverage: coverage(
      relationships.resolvedSemanticTables,
      semanticSignals.tables,
    ),
    unresolvedObjectCount,
    unresolvedObjects,
    ocrRequiredPages,
    readingOrderDiagnostics,
    readingOrderEvaluation,
  }
  const qualityDiagnostics: ReconstructionDiagnostic[] = []
  for (const page of pages.filter((candidate) =>
    ocrRequiredPages.includes(candidate.page),
  )) {
    if (
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'OCR_REQUIRED' &&
          diagnostic.severity === 'error' &&
          diagnostic.page === page.page,
      )
    ) {
      continue
    }
    qualityDiagnostics.push({
      code: 'OCR_REQUIRED',
      severity: 'error',
      page: page.page,
      message: `Page ${page.page} has insufficient source-backed text recovery and requires local OCR evidence.`,
      sourceBoxes: [
        {
          page: page.page,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          rotation: page.rotation,
          method: 'pdf-object',
        },
      ],
    })
  }
  const unresolvedEquationTranscripts = (visualRelationships ?? []).filter(
    (relationship) =>
      relationship.kind === 'equation' &&
      relationship.status === 'matched' &&
      !hasResolvedEquationTranscript(
        relationship,
        regions,
        pages,
        equationTranscriptContext,
      ),
  )
  for (const relationship of unresolvedEquationTranscripts) {
    qualityDiagnostics.push({
      code: 'UNRESOLVED_EQUATION_TRANSCRIPT',
      severity: 'error',
      page: relationship.sourceBoxes[0]?.page,
      message: `${relationship.label || relationship.id} has a matched visual rendition but no complete source-line-backed semantic transcript; its crop preserves visual fidelity without resolving equation semantics.`,
      sourceBoxes: relationship.sourceBoxes,
      relationshipId: relationship.id,
      target: {
        regionIds: relationship.sourceRegionIds,
        markerId: relationship.id,
      },
    })
  }
  const unresolvedAlgorithmTranscripts = (visualRelationships ?? []).filter(
    (relationship) =>
      relationship.semanticKind === 'algorithm' &&
      relationship.status === 'matched' &&
      (relationship.sourceText.trim().length === 0 ||
        relationship.evidence.includes('source-text-transcript-unresolved')),
  )
  for (const relationship of unresolvedAlgorithmTranscripts) {
    qualityDiagnostics.push({
      code: 'UNRESOLVED_ALGORITHM_TRANSCRIPT',
      severity: 'error',
      page: relationship.sourceBoxes[0]?.page,
      message: `${relationship.label || relationship.id} is preserved as an exact source visual, but its semantic line indentation and continuation ownership remain unresolved.`,
      sourceBoxes: relationship.sourceBoxes,
      relationshipId: relationship.id,
      target: {
        regionIds: relationship.sourceRegionIds,
        markerId: null,
      },
    })
  }
  const unresolvedPreformattedTranscripts = (visualRelationships ?? []).filter(
    (relationship) =>
      relationship.semanticKind === 'code' &&
      relationship.status === 'matched' &&
      (relationship.preformatted?.status !== 'proved' ||
        relationship.preformatted.lines.length === 0 ||
        relationship.evidence.includes('source-text-transcript-unresolved')),
  )
  for (const relationship of unresolvedPreformattedTranscripts) {
    qualityDiagnostics.push({
      code: 'UNRESOLVED_PREFORMATTED_TRANSCRIPT',
      severity: 'error',
      page: relationship.sourceBoxes[0]?.page,
      message: `${relationship.label || relationship.id} is preserved as an exact source crop, but its textual tokens, whitespace, indentation, or column ownership are not fully proved by source-line evidence.`,
      sourceBoxes: relationship.sourceBoxes,
      relationshipId: relationship.id,
      target: {
        regionIds: relationship.sourceRegionIds,
        markerId: null,
      },
    })
  }
  const textIntegrityIssues = canonicalTextIntegrityIssues(paper)
  if (textIntegrityIssues.length > 0) {
    const forbiddenXmlCharacterCount = textIntegrityIssues.reduce(
      (total, issue) => total + issue.forbiddenXmlCharacterCount,
      0,
    )
    const replacementGlyphCount = textIntegrityIssues.reduce(
      (total, issue) => total + issue.replacementGlyphCount,
      0,
    )
    const regionIds = [
      ...new Set(
        textIntegrityIssues.flatMap(
          (issue) => provenance?.[issue.nodeId]?.regionIds ?? [],
        ),
      ),
    ]
    qualityDiagnostics.push({
      code: 'EPUB_TEXT_SANITIZATION_LOSS',
      severity: 'error',
      message: `${textIntegrityIssues.length} canonical text field${textIntegrityIssues.length === 1 ? '' : 's'} contain ${forbiddenXmlCharacterCount} forbidden XML code point${forbiddenXmlCharacterCount === 1 ? '' : 's'} and ${replacementGlyphCount} Unicode replacement glyph${replacementGlyphCount === 1 ? '' : 's'}; EPUB export would be lossy or preserve known character corruption.`,
      ...(regionIds.length > 0
        ? { target: { regionIds, markerId: null } }
        : {}),
    })
  }
  const internalReferenceIssues = internalReferenceIntegrityIssues(
    paper,
    noteRelationships,
  )
  if (internalReferenceIssues.length > 0) {
    const regionIds = [
      ...new Set(
        internalReferenceIssues.flatMap(
          (issue) => provenance?.[issue.sourceId]?.regionIds ?? [],
        ),
      ),
    ]
    qualityDiagnostics.push({
      code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
      severity: 'error',
      message: `${internalReferenceIssues.length} canonical internal relationship${internalReferenceIssues.length === 1 ? '' : 's'} would render with a missing target or be silently omitted from EPUB navigation.`,
      ...(regionIds.length > 0
        ? { target: { regionIds, markerId: null } }
        : {}),
    })
  }
  if (completeness.textCoverage < policy.minimumTextCoverage) {
    qualityDiagnostics.push({
      code: 'INCOMPLETE_TEXT_COVERAGE',
      severity: 'error',
      message: `Recovered text coverage ${completeness.textCoverage.toFixed(3)} is below the configured minimum ${policy.minimumTextCoverage.toFixed(3)}.`,
    })
  }
  if (duplicateSpans > 0) {
    qualityDiagnostics.push({
      code: 'DUPLICATE_CANONICAL_SPAN',
      severity: 'error',
      message: `${duplicateSpans} canonical text span${duplicateSpans === 1 ? '' : 's'} exceed the source-backed occurrence count.`,
    })
  }
  const duplicateRoleNodeIds = duplicateCanonicalRoleNodeIds(paper)
  if (duplicateRoleNodeIds.length > 0) {
    const regionIds = [
      ...new Set(
        duplicateRoleNodeIds.flatMap(
          (nodeId) => provenance?.[nodeId]?.regionIds ?? [],
        ),
      ),
    ]
    qualityDiagnostics.push({
      code: 'DUPLICATE_CANONICAL_ROLE',
      severity: 'error',
      message: `${duplicateRoleNodeIds.length} canonical role${duplicateRoleNodeIds.length === 1 ? '' : 's'} repeat the publication title or an adjacent normalized-equal heading.`,
      ...(regionIds.length > 0
        ? { target: { regionIds, markerId: null } }
        : {}),
    })
  }
  if (flowOrderViolationNodeIds.length > 0) {
    const flowRegionIds = new Set(
      orderedSourceRegions
        .filter(
          (region) => region.kind === 'body' || region.kind === 'spanning',
        )
        .map((region) => region.id),
    )
    const regionIds = [
      ...new Set(
        flowOrderViolationNodeIds.flatMap((nodeId) =>
          (provenance?.[nodeId]?.regionIds ?? []).filter((regionId) =>
            flowRegionIds.has(regionId),
          ),
        ),
      ),
    ]
    qualityDiagnostics.push({
      code: 'CANONICAL_FLOW_ORDER_VIOLATION',
      severity: 'error',
      message: `${flowOrderViolationNodeIds.length} canonical text unit${flowOrderViolationNodeIds.length === 1 ? '' : 's'} cross or reverse source order, omit source text, or change source punctuation, operators, case, or token boundaries.`,
      ...(regionIds.length > 0
        ? { target: { regionIds, markerId: null } }
        : {}),
    })
  }
  if (visualOrderViolationRelationshipIds.length > 0) {
    const violatingRelationships = validatedVisualRelationships.filter(
      (relationship) =>
        visualOrderViolationRelationshipIds.includes(relationship.id),
    )
    qualityDiagnostics.push({
      code: 'CANONICAL_VISUAL_ORDER_VIOLATION',
      severity: 'error',
      message: `${visualOrderViolationRelationshipIds.length} matched visual relationship${visualOrderViolationRelationshipIds.length === 1 ? '' : 's'} reverse the source-proved order of their atomic visual-caption pairs.`,
      sourceBoxes: violatingRelationships.flatMap(
        (relationship) => relationship.sourceBoxes,
      ),
      target: {
        regionIds: [
          ...new Set(
            violatingRelationships.flatMap((relationship) => [
              relationship.captionRegionId,
              ...relationship.sourceRegionIds,
            ]),
          ),
        ],
        markerId: null,
      },
    })
  }
  if (completeness.missingSourceRegionCount > 0) {
    qualityDiagnostics.push({
      code: 'MISSING_SOURCE_REGION',
      severity: 'error',
      message: `${completeness.missingSourceRegionCount} nonempty source reading-order region${completeness.missingSourceRegionCount === 1 ? '' : 's'} have no canonical rendered unit.`,
      target: {
        regionIds: conservedText.missingSourceRegionIds,
        markerId: null,
      },
    })
  }
  if (completeness.unprovenancedRenderedUnitCount > 0) {
    qualityDiagnostics.push({
      code: 'UNPROVENANCED_RENDERED_UNIT',
      severity: 'error',
      message: `${completeness.unprovenancedRenderedUnitCount} nonempty rendered unit${completeness.unprovenancedRenderedUnitCount === 1 ? '' : 's'} lack valid source-region provenance.`,
    })
  }
  if (completeness.inlineSpanCoverage < 1) {
    qualityDiagnostics.push({
      code: 'INCOMPLETE_INLINE_STYLE_COVERAGE',
      severity: 'error',
      message: `Mapped ${completeness.mappedInlineSpanCount} of ${completeness.expectedInlineSpanCount} supported source inline-style spans into canonical content.`,
    })
  }
  if (
    completeness.hyperlinkCoverage < 1 &&
    !diagnostics.some(
      (diagnostic) => diagnostic.code === 'UNRESOLVED_HYPERLINK',
    )
  ) {
    qualityDiagnostics.push({
      code: 'UNRESOLVED_HYPERLINK',
      severity: 'error',
      message: `Mapped ${completeness.mappedHyperlinkCount} of ${completeness.expectedHyperlinkCount} source PDF link annotations exactly once into canonical inline runs.`,
    })
  }
  if (lineLedger.configured && !lineLedger.valid) {
    qualityDiagnostics.push({
      code: 'INVALID_LINE_BOUNDARY_LEDGER',
      severity: 'error',
      message: `The line-boundary ledger accounts for ${lineLedger.decided} of ${lineLedger.expected} adjacent source-line transitions or contains invalid transition evidence.`,
    })
  }
  if (lineLedger.unresolved > 0) {
    qualityDiagnostics.push({
      code: 'UNRESOLVED_CORRUPTING_JOIN',
      severity: 'error',
      message: `${lineLedger.unresolved} line-boundary decision${lineLedger.unresolved === 1 ? '' : 's'} remain unresolved and may corrupt continuous prose.`,
    })
  }
  if (completeness.assetCoverage < policy.minimumAssetCoverage) {
    qualityDiagnostics.push({
      code: 'INCOMPLETE_ASSET_COVERAGE',
      severity: 'error',
      message: `Reconstructed ${exportedAssetCount} of ${sourceAssetCount} detected semantic visual obligations; required coverage is ${policy.minimumAssetCoverage.toFixed(3)}.`,
    })
  }
  if (completeness.relationshipCoverage < policy.minimumRelationshipCoverage) {
    qualityDiagnostics.push({
      code: 'INCOMPLETE_RELATIONSHIP_COVERAGE',
      severity: 'error',
      message: `Resolved ${relationships.resolved} of ${relationships.expected} detected semantic relationships; required coverage is ${policy.minimumRelationshipCoverage.toFixed(3)}.`,
    })
  }
  if (
    completeness.expectedSemanticTableCount !== undefined &&
    completeness.resolvedSemanticTableCount !== undefined &&
    completeness.resolvedSemanticTableCount <
      completeness.expectedSemanticTableCount
  ) {
    qualityDiagnostics.push({
      code: 'INCOMPLETE_SEMANTIC_TABLE_COVERAGE',
      severity: 'error',
      message: `Reconstructed ${completeness.resolvedSemanticTableCount} of ${completeness.expectedSemanticTableCount} detected tables as semantic row-and-column structures; the remaining image fallback${completeness.expectedSemanticTableCount - completeness.resolvedSemanticTableCount === 1 ? '' : 's'} require review.`,
    })
  }
  if (unresolvedObjectCount > policy.maximumUnresolvedObjects) {
    qualityDiagnostics.push({
      code: 'UNRESOLVED_SEMANTIC_OBJECTS',
      severity: 'error',
      message: `${unresolvedObjectCount} detected semantic object${unresolvedObjectCount === 1 ? '' : 's'} remain unresolved (images ${unresolvedObjects.assets}, captions ${unresolvedObjects.captions}, tables ${unresolvedObjects.tables}, equations ${unresolvedObjects.equations}, citations ${unresolvedObjects.citations}, footnote references ${unresolvedObjects.footnoteReferences}, notes ${unresolvedObjects.footnotes}).`,
    })
  }

  const allDiagnostics = [...diagnostics, ...qualityDiagnostics]
  const policyFailed =
    completeness.ocrRequiredPages.length > policy.maximumOcrRequiredPages ||
    readingOrderDiagnostics > policy.maximumReadingOrderDiagnostics ||
    readingOrderEvaluation.reviewRequired
  const blockingDiagnosticCodes = [
    ...new Set([
      ...allDiagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => diagnostic.code),
      ...(readingOrderDiagnostics > policy.maximumReadingOrderDiagnostics
        ? allDiagnostics
            .filter(
              (diagnostic) =>
                diagnostic.code === 'LOW_CONFIDENCE_BLOCK' ||
                diagnostic.code === 'AMBIGUOUS_READING_ORDER',
            )
            .map((diagnostic) => diagnostic.code)
        : []),
    ]),
  ]
  const ready = blockingDiagnosticCodes.length === 0 && !policyFailed

  return {
    semanticSignals,
    completeness,
    diagnostics: allDiagnostics,
    readiness: {
      status: ready ? 'ready' : 'review-required',
      ready,
      policy: { ...policy },
      blockingDiagnosticCodes,
    },
  }
}
