import type {
  PdfCompletenessMetrics,
  PdfCompletenessPolicy,
  PdfCitationRelationship,
  PdfLineBoundaryDecision,
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
import { groupRunsIntoLines } from './pdf-lines'
import { classifyPdfNoteMarkers } from './pdf-note-classifier'
import { reconstructPageRegions } from './pdf-regions'
import {
  decorativeNativeObjectIds,
  isProbableDisplayEquation,
} from './pdf-visuals'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import type { ResearchNode, ResearchPaper } from './schema'

export const DEFAULT_PDF_COMPLETENESS_POLICY: PdfCompletenessPolicy = {
  minimumTextCoverage: 0.98,
  minimumAssetCoverage: 1,
  minimumRelationshipCoverage: 1,
  maximumUnresolvedObjects: 0,
  maximumOcrRequiredPages: 0,
  maximumReadingOrderDiagnostics: 0,
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
  policy?: PdfCompletenessPolicy
  reclassifiedNoteReferenceCount?: number
  reclassifiedCitationCount?: number
  lineBoundaryDecisions?: PdfLineBoundaryDecision[]
  unresolvedCorruptingJoinCount?: number
  structurallyConsumedLineBoundaryCount?: number
  provenance?: Record<string, NodeSourceEvidence>
  inlineSpanLedger?: { expected: number; mapped: number }
}

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function normalizedText(value: string) {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
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
) {
  const validatedRelationships = validatedPdfVisualRelationships({
    paper,
    provenance,
    relationships,
    assets,
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
    const sourceRegionIds =
      sourceRegionIdsByNode.get(relationship.canonicalNodeId) ?? []
    for (const regionId of relationship.sourceRegionIds) {
      if (!sourceRegionIds.includes(regionId)) sourceRegionIds.push(regionId)
    }
    sourceRegionIdsByNode.set(relationship.canonicalNodeId, sourceRegionIds)
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

function provenanceTextConservation({
  allRegions,
  orderedRegions,
  paper,
  provenance,
  visualRelationships,
  assets,
}: {
  allRegions: PdfPageRegion[]
  orderedRegions: PdfPageRegion[]
  paper: ResearchPaper
  provenance: Record<string, NodeSourceEvidence>
  visualRelationships?: PdfVisualRelationship[]
  assets?: PdfVisualAsset[]
}) {
  const allRegionMap = new Map(allRegions.map((region) => [region.id, region]))
  const orderedRegionMap = new Map(
    orderedRegions.map((region) => [region.id, region]),
  )
  const orderedRegionIds = new Set(orderedRegionMap.keys())
  const visualRepresentation = validatedVisualRepresentationByNode(
    paper,
    provenance,
    visualRelationships,
    assets,
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
  const metadataValues = canonicalTitleNode
    ? []
    : [paper.title, ...paper.authors, ...(paper.affiliations ?? [])]
  const affiliationMarkersByRegion = new Map<string, Array<[number, number]>>()
  for (const classification of classifyPdfNoteMarkers(orderedRegions)
    .classifications) {
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
  const metadataRegionIds = (value: string) => {
    const comparable = (text: string) =>
      text
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
    const target = comparable(value)
    if (!target) return []
    const representations = [
      (region: PdfPageRegion) => region.text,
      markerStrippedMetadataSourceText,
    ]
    for (const representation of representations) {
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
            return orderedRegions
              .slice(start, end + 1)
              .map((region) => region.id)
          }
          if (combined.length > target.length * 2 + 32) break
        }
      }
    }
    return []
  }
  for (const [index, value] of metadataValues.entries()) {
    const regionIds = metadataRegionIds(value)
    outputUnits.push({
      key: `output:metadata:${index}`,
      text: value,
      order: index,
      regionIds,
      provenanced: regionIds.length > 0,
      conservationExempt: false,
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
  for (const component of components.values()) {
    const source = normalizedText(
      component.regionIds
        .sort(
          (left, right) =>
            (regionOrder.get(left) ?? 0) - (regionOrder.get(right) ?? 0),
        )
        .map((regionId) => conservedRegionMap.get(regionId)?.text ?? '')
        .join(' '),
    )
    const output = normalizedText(
      component.outputs
        .sort((left, right) => left.order - right.order)
        .map((unit) => unit.text)
        .join(' '),
    )
    sourceCharacters += characterCount(source)
    outputCharacters += characterCount(output)
    matchedCharacters +=
      component.outputs.length > 0 &&
      component.outputs.every((unit) => unit.positionalVisual)
        ? occurrenceBoundedMatchedCharacters(source, output)
        : orderedMatchedCharacters(source, output)
    if (source && component.outputs.length === 0) {
      missingSourceRegionIds.push(...component.regionIds)
    }
  }

  return {
    sourceCharacters,
    outputCharacters,
    matchedCharacters,
    missingSourceRegionIds: [...new Set(missingSourceRegionIds)],
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
}: {
  decisions: PdfLineBoundaryDecision[]
  paper: ResearchPaper
  provenance?: Record<string, NodeSourceEvidence>
  visualRelationships?: PdfVisualRelationship[]
  assets?: PdfVisualAsset[]
}) {
  const validatedRelationships = validatedPdfVisualRelationships({
    paper,
    provenance,
    relationships: visualRelationships,
    assets,
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

export function detectPdfSemanticSignals(
  pages: PdfPageAnalysis[],
  suppliedRegions?: PdfPageRegion[],
): PdfSemanticSignals {
  const regions = suppliedRegions ?? reconstructPageRegions(pages).regions
  const markerResult = classifyPdfNoteMarkers(regions)
  const signals: PdfSemanticSignals = {
    captions: 0,
    tables: 0,
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
      if (/^(?:fig(?:ure)?\.?\s*\d+\b|figure\s*[:.-])/i.test(line.text)) {
        signals.captions += 1
      }
      if (/^table\s+(?:\d+|[ivxlcdm]+)\b/i.test(line.text)) {
        signals.tables += 1
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

function relationshipCounts(
  paper: ResearchPaper,
  signals: PdfSemanticSignals,
  visualRelationships?: PdfVisualRelationship[],
  citationRelationships?: PdfCitationRelationship[],
  provenance?: Record<string, NodeSourceEvidence>,
) {
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
  const resolvedTables =
    visualRelationships?.filter(
      (relationship) =>
        relationship.kind === 'table' && relationship.status === 'matched',
    ).length ?? 0
  const resolvedEquations =
    visualRelationships?.filter(
      (relationship) =>
        relationship.kind === 'equation' && relationship.status === 'matched',
    ).length ?? 0
  const noteIds = new Set(
    paper.nodes
      .filter((node) => node.type === 'footnote')
      .map((node) => node.id),
  )
  const noteReferences = paper.nodes.flatMap((node) =>
    'noteReferences' in node && node.noteReferences ? node.noteReferences : [],
  )
  const resolvedNoteReferences = noteReferences.filter((reference) =>
    noteIds.has(reference.target),
  )
  const resolvedNotes = new Set(
    resolvedNoteReferences.map((reference) => reference.target),
  )
  const nodesById = new Map(paper.nodes.map((node) => [node.id, node]))
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
      if (
        !node ||
        (node.type !== 'heading' &&
          node.type !== 'paragraph' &&
          node.type !== 'quote') ||
        anchor.start < 0 ||
        anchor.start >= anchor.end ||
        anchor.end > node.text.length ||
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
    for (let index = 0; index < remaining.length; ) {
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

export function assessPdfCompleteness({
  pages,
  paper,
  diagnostics,
  readingOrder,
  regions,
  visualRelationships,
  assets,
  citationRelationships,
  policy = DEFAULT_PDF_COMPLETENESS_POLICY,
  reclassifiedNoteReferenceCount = 0,
  reclassifiedCitationCount = 0,
  lineBoundaryDecisions,
  unresolvedCorruptingJoinCount,
  structurallyConsumedLineBoundaryCount,
  provenance,
  inlineSpanLedger = { expected: 0, mapped: 0 },
}: QualityInput): {
  semanticSignals: PdfSemanticSignals
  completeness: PdfCompletenessMetrics
  diagnostics: ReconstructionDiagnostic[]
  readiness: PdfReadiness
} {
  const semanticSignals = detectPdfSemanticSignals(pages, regions)
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
  })
  const allSourceRegions = regions ?? []
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
        })
      : {
          sourceCharacters: characterCount(sourceText),
          outputCharacters: characterCount(outputText),
          matchedCharacters: fallbackMatchedTextCharacters,
          missingSourceRegionIds: [],
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
    visualRelationships === undefined
      ? undefined
      : validatedVisualRelationships,
    citationRelationships,
    provenance,
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
  const readingOrderDiagnostics = readingOrderDiagnosticCount(diagnostics)
  const readingOrderEvaluation =
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
    unresolvedObjectCount,
    unresolvedObjects,
    ocrRequiredPages: pages
      .filter((page) => page.kind === 'ocr-required')
      .map((page) => page.page),
    readingOrderDiagnostics,
    readingOrderEvaluation,
  }
  const qualityDiagnostics: ReconstructionDiagnostic[] = []
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
