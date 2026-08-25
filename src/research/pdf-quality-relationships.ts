import type {
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfCitationRelationship,
  PdfLineBoundaryDecision,
  PdfNoteMarkerClassification,
  PdfNoteRelationship,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReadingOrderGraph,
  PdfSemanticSignals,
  PdfVisualAsset,
  PdfVisualRelationship,
} from './import-types'
import {
  verifyEquationTranscriptAdjudication,
  type EquationTranscriptContext,
} from './equation-transcript-adjudication'
import { verifyRelationshipSourceGeometryScriptTranscript } from './equation-geometry-transcript'
import {
  classifyPdfNoteMarkers,
  pdfAlternateAuthorYearKeyFromBoundary,
  pdfAuthorYearKey,
  pdfBibliographyAuthorYearKey,
} from './pdf-note-classifier'
import { parsePdfCitationSurface } from './pdf-citation-surface'
import { normalizedNoteLabel } from './note-label'
import {
  decorativeNativeObjectIds,
  hasUnprovedTwoDimensionalEquationTranscript,
  isProbableDisplayEquation,
} from './pdf-visuals'
import { validMatchedSemanticNoteRelationshipIds } from './publication-integrity'
import type { ResearchNode, ResearchPaper } from './schema'
import { isStrictSemanticTable } from './semantic-table'

function exactObjectKeys(value: unknown, expected: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function isNormalizedSourceBox(value: unknown): value is NormalizedSourceBox {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    exactObjectKeys(candidate, [
      'page',
      'x',
      'y',
      'width',
      'height',
      'rotation',
      'method',
    ]) &&
    Number.isSafeInteger(candidate.page) &&
    (candidate.page as number) >= 1 &&
    ['x', 'y', 'width', 'height', 'rotation'].every(
      (field) =>
        typeof candidate[field] === 'number' &&
        Number.isFinite(candidate[field]),
    ) &&
    (candidate.width as number) >= 0 &&
    (candidate.height as number) >= 0 &&
    ['pdf-text', 'pdf-object', 'pdf-link', 'ocr'].includes(
      candidate.method as string,
    )
  )
}

function sameNormalizedSourceBox(left: unknown, right: NormalizedSourceBox) {
  return (
    isNormalizedSourceBox(left) &&
    exactObjectKeys(right, [
      'page',
      'x',
      'y',
      'width',
      'height',
      'rotation',
      'method',
    ]) &&
    left.page === right.page &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.rotation === right.rotation &&
    left.method === right.method
  )
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
  const geometryScriptTranscript = Boolean(
    adjudicationContext &&
    verifyRelationshipSourceGeometryScriptTranscript({
      relationship,
      regions: adjudicationContext.regions,
      assets: adjudicationContext.assets,
    }),
  )
  if (
    relationship.kind !== 'equation' ||
    relationship.status !== 'matched' ||
    (relationship.sourceText.trim().length === 0 &&
      !geometryScriptTranscript) ||
    (relationship.evidence.includes('source-text-transcript-unresolved') &&
      !ownerAdjudicated &&
      !geometryScriptTranscript) ||
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
    !ownerAdjudicated &&
    !geometryScriptTranscript
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
    geometryScriptTranscript ||
    (normalizedEquationTranscript(completeSourceText).length > 0 &&
      normalizedEquationTranscript(relationship.sourceText) ===
        normalizedEquationTranscript(completeSourceText))
  )
}

function hasValidMatchedCitationEvidence({
  relationship,
  sourceClassification,
  sourceRegion,
  nodesById,
  anchorSourceRuns,
  lineBoundaryDecisions,
}: {
  relationship: PdfCitationRelationship
  sourceClassification: PdfNoteMarkerClassification | undefined
  sourceRegion: PdfPageRegion | undefined
  nodesById: ReadonlyMap<string, ResearchNode>
  anchorSourceRuns?: readonly {
    regionId: string
    box: NormalizedSourceBox
  }[]
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[]
}) {
  if (
    !sourceClassification ||
    !sourceRegion ||
    !sourceClassification.accepted ||
    sourceClassification.disposition !== 'citation' ||
    sourceClassification.id !== relationship.id ||
    sourceClassification.label !== relationship.label ||
    sourceClassification.taxonomy !== relationship.taxonomy ||
    sourceClassification.referenceRegionId !== relationship.referenceRegionId ||
    sourceClassification.start !== relationship.referenceStart ||
    sourceClassification.end !== relationship.referenceEnd ||
    !relationship.sourceBoxes.some((box) =>
      sameNormalizedSourceBox(box, sourceClassification.sourceBox),
    )
  ) {
    return false
  }
  const sourceText = sourceRegion.text.slice(
    relationship.referenceStart,
    relationship.referenceEnd,
  )
  if (!sourceText) return false
  const surface =
    relationship.labels.length === 1
      ? {
          identities: [...relationship.labels],
          links: [
            {
              identityIndex: 0,
              start: 0,
              end: sourceText.length,
            },
          ],
        }
      : parsePdfCitationSurface(sourceText)
  if (
    !surface ||
    surface.identities.length !== relationship.labels.length ||
    surface.identities.some(
      (identity, index) => identity !== relationship.labels[index],
    )
  ) {
    return false
  }
  const targetEvidence = relationship.targets ?? []
  if (targetEvidence.length !== surface.links.length) return false
  const anchoredSourceBoxes = [
    ...relationship.sourceBoxes,
    ...targetEvidence.flatMap((target) => target.sourceBoxes),
  ]
  if (
    anchorSourceRuns &&
    (anchorSourceRuns.length === 0 ||
      anchoredSourceBoxes.length === 0 ||
      anchoredSourceBoxes.some(
        (box) =>
          !anchorSourceRuns.some(
            (run) =>
              run.regionId === relationship.referenceRegionId &&
              materiallyOverlappingSourceBoxes(box, run.box),
          ),
      ))
  ) {
    return false
  }
  for (const [index, link] of surface.links.entries()) {
    const target = targetEvidence[index]
    const label = relationship.labels[link.identityIndex]
    const targetNodeId = relationship.targetNodeIds[link.identityIndex]
    if (
      !target ||
      target.label !== label ||
      target.targetNodeId !== targetNodeId ||
      target.referenceStart !== relationship.referenceStart + link.start ||
      target.referenceEnd !== relationship.referenceStart + link.end ||
      !target.evidence.includes('ordered-citation-label-target-cardinality') ||
      !target.evidence.includes('exact-replayed-source-run-range') ||
      !target.evidence.includes('target-specific-source-geometry') ||
      target.sourceBoxes.length === 0 ||
      target.sourceBoxes.some(
        (box) =>
          !sourceRegion.lines.some((line) =>
            line.runs.some((run) => materiallyOverlappingSourceBoxes(box, run)),
          ),
      )
    ) {
      return false
    }
  }
  return relationship.targetNodeIds.every((targetNodeId, index) => {
    const target = nodesById.get(targetNodeId)
    if (
      target?.type !== 'paragraph' ||
      target.list?.numberingId !== 'references'
    ) {
      return false
    }
    const label = relationship.labels[index]
    if (relationship.taxonomy === 'author-year-bibliography-citation') {
      const targetKey = pdfBibliographyAuthorYearKey(target.text)
      if (targetKey === label) return true
      const sourceLink = surface.links.find(
        (link) => link.identityIndex === index,
      )
      const citationText = sourceLink
        ? sourceText.slice(sourceLink.start, sourceLink.end)
        : ''
      const firstSurname = citationText.match(
        /^\s*(\p{Lu}[\p{L}\p{M}'’.-]*)/u,
      )?.[1]
      const year = label.match(/:((?:18|19|20)\d{2}[a-z]?)$/u)?.[1]
      const surnameOffset = firstSurname
        ? citationText.indexOf(firstSurname)
        : -1
      if (
        !relationship.evidence.includes(
          'author-year-key-normalized-from-unresolved-line-boundary-hyphen',
        ) ||
        !sourceLink ||
        !firstSurname ||
        !year ||
        surnameOffset < 0 ||
        pdfAuthorYearKey(firstSurname, year) !== label
      ) {
        return false
      }
      return (
        targetKey ===
        pdfAlternateAuthorYearKeyFromBoundary(
          sourceRegion,
          lineBoundaryDecisions,
          firstSurname,
          year,
          relationship.referenceStart + sourceLink.start + surnameOffset,
        )
      )
    }
    const normalizedLabel = normalizedNoteLabel(label)
    return (
      target.list.ordinal?.toString() === normalizedLabel ||
      normalizedNoteLabel(target.list.markerText ?? '') === normalizedLabel
    )
  })
}

export function relationshipCounts(
  paper: ResearchPaper,
  signals: PdfSemanticSignals,
  pages: readonly PdfPageAnalysis[],
  visualRelationships?: PdfVisualRelationship[],
  citationRelationships?: PdfCitationRelationship[],
  noteRelationships?: PdfNoteRelationship[],
  provenance?: Record<string, NodeSourceEvidence>,
  assets: PdfVisualAsset[] = [],
  regions?: readonly PdfPageRegion[],
  equationTranscriptContext?: EquationTranscriptContext,
  readingOrder?: PdfReadingOrderGraph,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[] = [],
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
    ...paper.nodes.flatMap((node) => [
      ...('noteReferences' in node && node.noteReferences
        ? node.noteReferences
        : []),
      ...(node.type === 'figure' && node.table
        ? node.table.rows.flatMap((row) =>
            row.cells.flatMap((cell) => cell.noteReferences ?? []),
          )
        : []),
    ]),
  ]
  const validNoteRelationshipIds =
    noteRelationships === undefined
      ? null
      : validMatchedSemanticNoteRelationshipIds(paper, noteRelationships, {
          regions: regions ?? [],
          provenance: provenance ?? {},
        })
  const resolvedNoteReferences = noteReferences.filter(
    (reference) =>
      noteIds.has(reference.target) &&
      (validNoteRelationshipIds === null ||
        validNoteRelationshipIds.has(reference.id)),
  )
  const resolvedNotes = new Set(
    resolvedNoteReferences.map((reference) => reference.target),
  )
  const tableCellOwners = new Map(
    paper.nodes.flatMap((node) =>
      node.type === 'figure' && node.table
        ? node.table.rows.flatMap((row, rowIndex) =>
            row.cells.map(
              (cell, cellIndex) =>
                [
                  `${node.id}:table:${cell.id ?? `${rowIndex}:${cellIndex}`}` as string,
                  {
                    text: cell.text,
                    inlineRuns: cell.inlineRuns,
                    provenanceNodeId: node.id,
                    sourceRuns: cell.sourceRuns ?? [],
                  },
                ] as const,
            ),
          )
        : [],
    ),
  )
  const sourceRegionsById = new Map(
    (regions ?? []).map((region) => [region.id, region] as const),
  )
  const sourceCitationClassificationsById = new Map(
    classifyPdfNoteMarkers(
      [...(regions ?? [])],
      readingOrder?.order,
      lineBoundaryDecisions,
    ).classifications.flatMap((classification) =>
      classification.disposition === 'citation'
        ? [[classification.id, classification] as const]
        : [],
    ),
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
      const tableCellOwner = tableCellOwners.get(anchor.nodeId)
      const anchorText = tableCellOwner
        ? tableCellOwner.text
        : node?.type === 'figure'
          ? (node.sourceText ?? '')
          : node && 'text' in node
            ? node.text
            : ''
      const inlineRuns = tableCellOwner?.inlineRuns ?? node?.inlineRuns
      const provenanceNodeId = tableCellOwner?.provenanceNodeId ?? node?.id
      if (
        (!node && !tableCellOwner) ||
        (!tableCellOwner &&
          node?.type !== 'heading' &&
          node?.type !== 'paragraph' &&
          node?.type !== 'quote' &&
          node?.type !== 'caption' &&
          !(
            node?.type === 'figure' &&
            node.objectType === 'table' &&
            node.sourceText
          )) ||
        anchor.start < 0 ||
        anchor.start >= anchor.end ||
        anchor.end > anchorText.length ||
        !hasValidMatchedCitationEvidence({
          relationship,
          sourceClassification: sourceCitationClassificationsById.get(
            relationship.id,
          ),
          sourceRegion: sourceRegionsById.get(relationship.referenceRegionId),
          nodesById,
          lineBoundaryDecisions,
          ...(tableCellOwner
            ? { anchorSourceRuns: tableCellOwner.sourceRuns }
            : {}),
        }) ||
        !provenanceNodeId ||
        !provenance?.[provenanceNodeId]?.regionIds.includes(
          relationship.referenceRegionId,
        )
      ) {
        return false
      }
      return Boolean(
        inlineRuns?.some(
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
