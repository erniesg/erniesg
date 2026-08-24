import type {
  NodeSourceEvidence,
  PdfLineBoundaryDecision,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceSemanticFlowBoundaryDecision,
  PdfVisualAsset,
  PdfVisualRelationship,
} from './import-types'
import { classifyPdfNoteMarkers } from './pdf-note-classifier'
import { inlineHardHyphenLexicon, inlineUnhyphenatedLexicon } from './pdf-lines'
import type { ResearchNode, ResearchPaper } from './schema'
import {
  characterCount,
  meaningPreservingText,
  normalizedText,
  occurrenceBoundedMatchedCharacters,
  orderedMatchedCharacters,
  sourceProvenBoundaryTokenText,
  type SourceSemanticFlowBoundaryLedgerAudit,
} from './pdf-quality-text'

export type ProvenanceTextConservationInput = {
  allRegions: PdfPageRegion[]
  orderedRegions: PdfPageRegion[]
  paper: ResearchPaper
  provenance: Record<string, NodeSourceEvidence>
  visualRelationships?: PdfVisualRelationship[]
  validatedVisualRelationships?: PdfVisualRelationship[]
  assets?: PdfVisualAsset[]
  pages?: readonly PdfPageAnalysis[]
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[]
  sourceSemanticFlowBoundaryDecisions?: readonly PdfSourceSemanticFlowBoundaryDecision[]
}

type VisualRepresentation = {
  textByNode: Map<string, string>
  sourceRegionIdsByNode: Map<string, string[]>
  positionalNodeIds: Set<string>
  lineageConnectorNodeIds: Set<string>
}

type ProvenanceTextConservationHelpers = {
  auditSourceSemanticFlowBoundaryLedger: (input: {
    allRegions: readonly PdfPageRegion[]
    visualRelationships: readonly PdfVisualRelationship[]
    validatedNonProseRelationships: readonly PdfVisualRelationship[]
    lineBoundaryDecisions: readonly PdfLineBoundaryDecision[]
    decisions: readonly PdfSourceSemanticFlowBoundaryDecision[]
    hardHyphenLexicon: ReadonlySet<string>
    unhyphenatedLexicon: ReadonlySet<string>
    language: string | null
    baseDirection: ResearchPaper['baseDirection'] | null
  }) => SourceSemanticFlowBoundaryLedgerAudit
  nodeText: (node: ResearchNode, validatedVisualText?: string) => string
  validatedVisualRepresentationByNode: (
    paper: ResearchPaper,
    provenance: Record<string, NodeSourceEvidence> | undefined,
    relationships: PdfVisualRelationship[] | undefined,
    assets: PdfVisualAsset[] | undefined,
    regions?: readonly PdfPageRegion[],
    pages?: readonly PdfPageAnalysis[],
  ) => VisualRepresentation
  unresolvedAuthorPlaceholder: string
}

export function calculateProvenanceTextConservation(
  {
    allRegions,
    orderedRegions,
    paper,
    provenance,
    visualRelationships,
    validatedVisualRelationships,
    assets,
    pages,
    lineBoundaryDecisions,
    sourceSemanticFlowBoundaryDecisions = [],
  }: ProvenanceTextConservationInput,
  {
    auditSourceSemanticFlowBoundaryLedger,
    nodeText,
    validatedVisualRepresentationByNode,
    unresolvedAuthorPlaceholder,
  }: ProvenanceTextConservationHelpers,
) {
  const allRegionMap = new Map(allRegions.map((region) => [region.id, region]))
  const sourceLines = allRegions.flatMap((region) => region.lines)
  const hardHyphenLexicon = inlineHardHyphenLexicon(sourceLines)
  const unhyphenatedLexicon = inlineUnhyphenatedLexicon(sourceLines)
  const semanticFlowBoundaryLedger = auditSourceSemanticFlowBoundaryLedger({
    allRegions,
    visualRelationships: visualRelationships ?? [],
    validatedNonProseRelationships: validatedVisualRelationships ?? [],
    lineBoundaryDecisions,
    decisions: sourceSemanticFlowBoundaryDecisions,
    hardHyphenLexicon,
    unhyphenatedLexicon,
    language: paper.language ?? null,
    baseDirection: paper.baseDirection ?? null,
  })
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
    pages,
  )
  const nodesById = new Map(paper.nodes.map((node) => [node.id, node]))
  const generatedEquationCaptionNodeIds = new Set(
    (visualRelationships ?? []).flatMap((relationship) =>
      relationship.kind === 'equation' &&
      relationship.captionNodeId !== null &&
      (() => {
        const caption = nodesById.get(relationship.captionNodeId)
        if (caption?.type !== 'caption') return false
        const captionText = caption.text.trim()
        const normalizedCaption = captionText.replace(/[.]$/u, '').trim()
        const normalizedLabel = relationship.label
          .trim()
          .replace(/[.]$/u, '')
          .trim()
        return (
          /^Display equation p\d{3}-\d{3}$/u.test(captionText) ||
          normalizedCaption === normalizedLabel
        )
      })()
        ? [relationship.captionNodeId]
        : [],
    ),
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
    // Equation captions generated from a printed number or a stable internal
    // identity label are not source prose. The typed equation relationship
    // owns (or fail-closed rejects) the source glyph region; comparing that
    // label with the glyph transcript invents a canonical-flow violation and
    // can expose an internal label in prose-quality evidence.
    const rendered = generatedEquationCaptionNodeIds.has(node.id)
      ? ''
      : nodeText(node, visualRepresentation.textByNode.get(node.id))
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
    .filter((value) => value !== unresolvedAuthorPlaceholder)
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
    const sourceRegionTexts = orderedComponentRegionIds.map(
      (regionId) => conservedRegionMap.get(regionId)?.text ?? '',
    )
    const sourceComponentRegions = orderedComponentRegionIds.flatMap(
      (regionId) => {
        const region = conservedRegionMap.get(regionId)
        return region ? [region] : []
      },
    )
    const rawSourceText = sourceRegionTexts.join(' ')
    const outputText = orderedComponentOutputs
      .map((unit) => unit.text)
      .join(' ')
    const semanticOutputNodes = orderedComponentOutputs
      .map((unit) => (unit.nodeId ? nodesById.get(unit.nodeId) : undefined))
      .filter((node): node is ResearchNode => node !== undefined)
    const noteOnlyComponent =
      semanticOutputNodes.length === orderedComponentOutputs.length &&
      semanticOutputNodes.length > 0 &&
      semanticOutputNodes.every((node) => node.type === 'footnote') &&
      orderedComponentRegionIds.every((regionId) =>
        ['footnote', 'endnote'].includes(
          conservedRegionMap.get(regionId)?.kind ?? '',
        ),
      )
    const stripLeadingNoteMarker = (value: string) =>
      value.replace(/^\s*(?:[\d⁰¹²³⁴⁵⁶⁷⁸⁹]+|[*∗†‡§]+)[.)]?\s*/u, '')
    const sourceText = rawSourceText
    const comparableSourceText = noteOnlyComponent
      ? stripLeadingNoteMarker(sourceText)
      : sourceText
    const comparableOutputText = noteOnlyComponent
      ? stripLeadingNoteMarker(outputText)
      : outputText
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
              noteOnlyComponent
                ? [
                    stripLeadingNoteMarker(sourceRegionTexts[0] ?? ''),
                    ...sourceRegionTexts.slice(1),
                  ]
                : sourceRegionTexts,
              hardHyphenLexicon,
              unhyphenatedLexicon,
              paper.language ?? null,
              sourceComponentRegions,
              semanticFlowBoundaryLedger,
              semanticOutputNodes.length > 0 &&
                semanticOutputNodes.every(
                  (node) => node.type === 'paragraph' && !node.list,
                ),
            )
          : comparableSourceText,
      ) !== meaningPreservingText(comparableOutputText)
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
  if (
    [...semanticFlowBoundaryLedger.consumptionById.values()].some(
      (consumptionCount) => consumptionCount !== 1,
    )
  ) {
    semanticFlowBoundaryLedger.valid = false
  }
  if (!semanticFlowBoundaryLedger.valid) {
    for (const nodeId of canonicalTextNodeIds) {
      semanticTextViolationNodeIds.add(nodeId)
    }
  }

  return {
    sourceCharacters,
    outputCharacters,
    matchedCharacters,
    missingSourceRegionIds: [...new Set(missingSourceRegionIds)],
    sameRegionFlowViolationNodeIds: [...sameRegionFlowViolationNodeIds],
    semanticTextViolationNodeIds: [...semanticTextViolationNodeIds],
    semanticFlowBoundaryLedgerValid: semanticFlowBoundaryLedger.valid,
    unprovenancedRenderedUnitKeys: outputUnits
      .filter((unit) => !unit.provenanced)
      .map((unit) => unit.key),
  }
}
