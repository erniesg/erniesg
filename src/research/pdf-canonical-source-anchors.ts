import type { ResearchNode } from './schema'
import type {
  NormalizedSourceBox,
  PdfCitationRelationship,
  PdfNoteRelationship,
  PdfPageRegion,
  PdfVisualRelationship,
} from './import-types'
import { noteLabelsFromMarkerText } from './pdf-note-classifier'
import { normalizedNoteLabel } from './pdf-regions'
import { boxesOverlap } from './pdf-visual-source-mapping'
import type { CanonicalTable } from './visual-assets'

export type PdfCanonicalSourceBlock = {
  region: Pick<PdfPageRegion, 'id'>
  text: string
  nodeId?: string
  sourceSegments?: Array<{
    region: Pick<PdfPageRegion, 'id'>
    sourceStart: number
    canonicalStart: number
    text: string
  }>
}

export type PdfCanonicalNoteReference = {
  id: string
  label: string
  region: Pick<PdfPageRegion, 'id' | 'text'>
  start: number
  end: number
  author?: string
  canonicalAnchor:
    | { kind: 'node'; nodeId: string; start: number; end: number }
    | { kind: 'author'; author: string }
    | null
}

type CanonicalInlineRun = NonNullable<
  Extract<ResearchNode, { type: 'paragraph' }>['inlineRuns']
>[number]

function canonicalSourceSegments(block: PdfCanonicalSourceBlock) {
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

export function canonicalRangeForSource(
  block: PdfCanonicalSourceBlock,
  regionId: string,
  start: number,
  end: number,
) {
  for (const segment of canonicalSourceSegments(block)) {
    if (segment.region.id !== regionId) continue
    const sourceEnd = segment.sourceStart + segment.text.length
    const overlapStart = Math.max(start, segment.sourceStart)
    const overlapEnd = Math.min(end, sourceEnd)
    if (overlapStart >= overlapEnd) continue
    return {
      start: segment.canonicalStart + overlapStart - segment.sourceStart,
      end: segment.canonicalStart + overlapEnd - segment.sourceStart,
    }
  }
  return null
}

export function exactCanonicalRangeForSource(
  block: PdfCanonicalSourceBlock,
  regionId: string,
  start: number,
  end: number,
) {
  if (start < 0 || start >= end) return null
  const containsExactRange = canonicalSourceSegments(block).some(
    (segment) =>
      segment.region.id === regionId &&
      segment.sourceStart <= start &&
      segment.sourceStart + segment.text.length >= end,
  )
  if (!containsExactRange) return null
  const range = canonicalRangeForSource(block, regionId, start, end)
  return range && range.end - range.start === end - start ? range : null
}

export function canonicalHyperlinkOccurrencesForTable(table: CanonicalTable) {
  return table.rows.flatMap((row) =>
    row.cells.flatMap((cell) =>
      (cell.inlineRuns ?? []).flatMap((run) =>
        run.annotationId && run.href
          ? [{ annotationId: run.annotationId, url: run.href }]
          : [],
      ),
    ),
  )
}

export function canonicalTableHyperlinkOccurrences(
  relationships: PdfVisualRelationship[],
  drafts: ReadonlyMap<string, unknown>,
  tablesByAssetId: ReadonlyMap<string, CanonicalTable>,
) {
  return relationships.flatMap((relationship) => {
    if (!drafts.has(relationship.id)) return []
    const table = relationship.assetIds
      .map((assetId) => tablesByAssetId.get(assetId))
      .find((candidate) => candidate !== undefined)
    if (!table) return []
    return canonicalHyperlinkOccurrencesForTable(table)
  })
}

export function canonicalTableWithApprovedHyperlinks(
  table: CanonicalTable,
  approvedAnnotationIds: ReadonlySet<string>,
): CanonicalTable {
  return {
    rows: table.rows.map((row) => ({
      cells: row.cells.map((cell) => {
        const removedAnnotationCount = (cell.inlineRuns ?? []).filter(
          (run) =>
            run.annotationId !== undefined &&
            !approvedAnnotationIds.has(run.annotationId),
        ).length
        const inlineRuns = (cell.inlineRuns ?? []).flatMap((run) => {
          if (
            !run.annotationId ||
            approvedAnnotationIds.has(run.annotationId)
          ) {
            return [run]
          }
          const { annotationId: _annotationId, href: _href, ...rest } = run
          return rest.bold || rest.italic || rest.verticalAlign ? [rest] : []
        })
        return {
          ...cell,
          ...(inlineRuns.length > 0 ? { inlineRuns } : {}),
          ...(cell.inlineMapping
            ? {
                inlineMapping: {
                  expected: Math.max(
                    0,
                    cell.inlineMapping.expected - removedAnnotationCount,
                  ),
                  mapped: Math.max(
                    0,
                    cell.inlineMapping.mapped - removedAnnotationCount,
                  ),
                },
              }
            : {}),
        }
      }),
    })),
  }
}

/**
 * Project visual-transcript citations into their unique source-backed table
 * cells. Repeated marker text remains unresolved unless target-specific
 * source geometry selects exactly one cell.
 */
export function canonicalTableWithSemanticInlineRuns({
  table,
  sourceText,
  inlineRuns,
  citationRelationships,
  noteReferences = [],
}: {
  table: CanonicalTable
  sourceText: string
  inlineRuns: readonly CanonicalInlineRun[]
  citationRelationships: readonly PdfCitationRelationship[]
  noteReferences?: readonly {
    id: string
    label: string
    target: string | null
    start: number
    end: number
    confidence: number
    status: PdfNoteRelationship['status']
    referenceRegionId: string
    sourceBoxes: readonly NormalizedSourceBox[]
  }[]
}): CanonicalTable {
  const citationsById = new Map(
    citationRelationships.map((relationship) => [
      relationship.id,
      relationship,
    ]),
  )
  const projections = inlineRuns.flatMap((run) => {
    if (
      run.semanticRole !== 'citation' ||
      !run.relationshipId ||
      run.start < 0 ||
      run.start >= run.end ||
      run.end > sourceText.length
    ) {
      return []
    }
    const relationship = citationsById.get(run.relationshipId)
    if (!relationship) return []
    const marker = sourceText.slice(run.start, run.end)
    if (!marker) return []
    const targetBoxes =
      relationship.targets?.flatMap((target) => target.sourceBoxes) ?? []
    const proofBoxes =
      targetBoxes.length > 0 ? targetBoxes : relationship.sourceBoxes
    const candidates = table.rows.flatMap((row, rowIndex) =>
      row.cells.flatMap((cell, cellIndex) => {
        const start = cell.text.indexOf(marker)
        if (
          start < 0 ||
          cell.text.indexOf(marker, start + 1) >= 0 ||
          !cell.sourceRuns?.length ||
          proofBoxes.length === 0 ||
          !proofBoxes.every((box) =>
            cell.sourceRuns!.some(
              (sourceRun) =>
                sourceRun.regionId === relationship.referenceRegionId &&
                boxesOverlap(box, sourceRun.box),
            ),
          )
        ) {
          return []
        }
        return [{ rowIndex, cellIndex, start, end: start + marker.length }]
      }),
    )
    return candidates.length === 1 ? [{ run, ...candidates[0] }] : []
  })
  const projectedNotes = noteReferences.flatMap((reference) => {
    if (
      reference.start < 0 ||
      reference.start >= reference.end ||
      reference.end > sourceText.length ||
      reference.sourceBoxes.length === 0
    ) {
      return []
    }
    const marker = sourceText.slice(reference.start, reference.end)
    if (!marker) return []
    const candidates = table.rows.flatMap((row, rowIndex) =>
      row.cells.flatMap((cell, cellIndex) => {
        const start = cell.text.indexOf(marker)
        if (
          start < 0 ||
          cell.text.indexOf(marker, start + 1) >= 0 ||
          !cell.sourceRuns?.length ||
          !reference.sourceBoxes.every((box) =>
            cell.sourceRuns!.some(
              (sourceRun) =>
                sourceRun.regionId === reference.referenceRegionId &&
                boxesOverlap(box, sourceRun.box),
            ),
          )
        ) {
          return []
        }
        return [{ rowIndex, cellIndex, start, end: start + marker.length }]
      }),
    )
    return candidates.length === 1 ? [{ reference, ...candidates[0] }] : []
  })
  if (projections.length === 0 && projectedNotes.length === 0) return table
  return {
    rows: table.rows.map((row, rowIndex) => ({
      cells: row.cells.map((cell, cellIndex) => {
        const semanticRuns = projections
          .filter(
            (projection) =>
              projection.rowIndex === rowIndex &&
              projection.cellIndex === cellIndex,
          )
          .map(({ run, start, end }) => ({ ...run, start, end }))
        const cellNotes = projectedNotes.filter(
          (projection) =>
            projection.rowIndex === rowIndex &&
            projection.cellIndex === cellIndex,
        )
        if (semanticRuns.length === 0 && cellNotes.length === 0) return cell
        const matchedNotes = cellNotes.flatMap(({ reference, start, end }) =>
          reference.status === 'matched' && reference.target
            ? [
                {
                  id: reference.id,
                  label: reference.label,
                  target: reference.target,
                  start,
                  end,
                  confidence: reference.confidence,
                },
              ]
            : [],
        )
        const unresolvedNoteRuns = cellNotes.flatMap(
          ({ reference, start, end }) =>
            reference.status !== 'matched'
              ? [
                  {
                    start,
                    end,
                    relationshipId: reference.id,
                    semanticRole: 'note-reference' as const,
                  },
                ]
              : [],
        )
        return {
          ...cell,
          ...(matchedNotes.length > 0
            ? {
                noteReferences: [
                  ...(cell.noteReferences ?? []),
                  ...matchedNotes,
                ],
              }
            : {}),
          ...(semanticRuns.length > 0 || unresolvedNoteRuns.length > 0
            ? {
                inlineRuns: [
                  ...(cell.inlineRuns ?? []),
                  ...semanticRuns,
                  ...unresolvedNoteRuns,
                ].sort(
                  (left, right) =>
                    left.start - right.start ||
                    left.end - right.end ||
                    String(left.relationshipId ?? '').localeCompare(
                      String(right.relationshipId ?? ''),
                    ),
                ),
              }
            : {}),
        }
      }),
    })),
  }
}

export function exactCanonicalNoteReferenceAnchor(
  reference: PdfCanonicalNoteReference,
  canonicalBlocks: PdfCanonicalSourceBlock[],
  renderedAuthorReferenceIds: ReadonlySet<string>,
): PdfCanonicalNoteReference['canonicalAnchor'] {
  if (
    reference.start < 0 ||
    reference.end <= reference.start ||
    reference.end > reference.region.text.length
  ) {
    return null
  }
  const sourceMarker = reference.region.text.slice(
    reference.start,
    reference.end,
  )
  const sourceLabels =
    noteLabelsFromMarkerText(sourceMarker).map(normalizedNoteLabel)
  const expectedLabels = reference.label
    .split(',')
    .map(normalizedNoteLabel)
    .filter(Boolean)
  if (
    sourceLabels.length !== expectedLabels.length ||
    sourceLabels.some((label, index) => label !== expectedLabels[index])
  ) {
    return null
  }
  if (renderedAuthorReferenceIds.has(reference.id)) {
    return 'author' in reference && typeof reference.author === 'string'
      ? { kind: 'author', author: reference.author }
      : null
  }
  const candidates = canonicalBlocks.flatMap((block) => {
    if (!block.nodeId) return []
    const range = exactCanonicalRangeForSource(
      block,
      reference.region.id,
      reference.start,
      reference.end,
    )
    return range && block.text.slice(range.start, range.end) === sourceMarker
      ? [{ kind: 'node' as const, nodeId: block.nodeId, ...range }]
      : []
  })
  return candidates.length === 1 ? candidates[0] : null
}
