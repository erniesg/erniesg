import type {
  DocumentReconstruction,
  NodeSourceEvidence,
  PdfPageRegion,
  PdfReconstruction,
} from '../research/import-types'
import type { ResearchNode } from '../research/schema'
import { recoveryDiagnosticInputs } from '../research/recovery-projection'
import { structDigest, structId } from './ids'
import { recoverySummary, toStructDiagnostic } from './recovery'
import { orderBlocksByLayout, pageLayoutsFromBlocks } from './reading-order'
import type {
  StructAsset,
  StructBlock,
  StructBlockKind,
  StructDocument,
  StructEvidence,
  StructFurnitureEvidence,
  StructFurnitureReview,
  StructInline,
  StructRelationship,
  StructSourceFormat,
  StructTable,
  StructTableCell,
} from './types'

function isPdf(
  reconstruction: DocumentReconstruction,
): reconstruction is PdfReconstruction {
  return reconstruction.source.format !== 'docx'
}

function sourceFormat(
  reconstruction: DocumentReconstruction,
): StructSourceFormat {
  return reconstruction.source.format === 'docx' ? 'docx' : 'pdf'
}

function boxEvidence(
  evidence: NodeSourceEvidence | undefined,
  fallbackId: string,
): StructEvidence {
  return {
    confidence: Math.max(0, Math.min(1, evidence?.confidence ?? 0)),
    pages: [...new Set(evidence?.pages ?? [])].sort(
      (left, right) => left - right,
    ),
    boxes: (evidence?.boxes ?? []).map(
      ({ page, x, y, width, height, rotation }) => ({
        page,
        x,
        y,
        width,
        height,
        rotation,
      }),
    ),
    sourceIds: [
      fallbackId,
      ...(evidence?.regionIds ?? []),
      ...(evidence?.relationshipIds ?? []),
    ],
  }
}

function nodeKind(node: ResearchNode): StructBlockKind {
  if (node.type === 'heading') return 'heading'
  if (node.type === 'paragraph') return node.list ? 'list-item' : 'paragraph'
  if (node.type === 'quote') return 'quote'
  if (node.type === 'caption') return 'caption'
  if (node.type === 'footnote')
    return node.kind === 'endnote' ? 'endnote' : 'footnote'
  if (node.type === 'figure') {
    return node.objectType === 'table'
      ? 'table'
      : node.objectType === 'equation'
        ? 'equation'
        : 'figure'
  }
  return 'unknown'
}

function nodeText(node: ResearchNode) {
  if (node.type === 'figure') return node.sourceText ?? node.title
  return 'text' in node ? node.text : ''
}

function inlineRuns(
  node: ResearchNode,
  resolveEndpoint: (id: string) => string,
  resolveRelationship: (id: string) => string,
): StructInline[] {
  const semanticRuns =
    'inlineRuns' in node
      ? (node.inlineRuns ?? []).map((run) => ({
          start: run.start,
          end: run.end,
          ...(run.href ? { href: run.href } : {}),
          ...(run.annotationId ? { annotationId: run.annotationId } : {}),
          ...(run.relationshipId
            ? { relationshipId: resolveRelationship(run.relationshipId) }
            : {}),
          ...(run.targetIds
            ? { targetIds: run.targetIds.map(resolveEndpoint) }
            : {}),
          ...(run.bold ? { bold: true } : {}),
          ...(run.italic ? { italic: true } : {}),
          ...(run.verticalAlign ? { verticalAlign: run.verticalAlign } : {}),
          ...(run.compactMathAtom ? { compactMathAtom: true } : {}),
          ...(run.semanticRole ? { semanticRole: run.semanticRole } : {}),
        }))
      : []
  const noteRuns =
    'noteReferences' in node
      ? (node.noteReferences ?? []).map((reference) => ({
          start: reference.start,
          end: reference.end,
          href: `#${resolveEndpoint(reference.target)}`,
          relationshipId: resolveRelationship(reference.id),
          targetIds: [resolveEndpoint(reference.target)],
          semanticRole: 'note-reference' as const,
        }))
      : []
  return [...semanticRuns, ...noteRuns].sort(
    (left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      String(left.relationshipId ?? '').localeCompare(
        String(right.relationshipId ?? ''),
      ),
  )
}

function stableBoxKey(evidence: StructEvidence) {
  return [...evidence.boxes]
    .sort(
      (left, right) =>
        left.page - right.page ||
        left.y - right.y ||
        left.x - right.x ||
        left.width - right.width ||
        left.height - right.height ||
        left.rotation - right.rotation,
    )
    .map(({ page, x, y, width, height, rotation }) =>
      [page, x, y, width, height, rotation].join(':'),
    )
    .join('|')
}

function stableBlockId({
  sourceSha256,
  kind,
  text,
  evidence,
  sourcePosition,
}: {
  sourceSha256: string
  kind: StructBlockKind
  text: string
  evidence: StructEvidence
  sourcePosition: number
}) {
  const position = stableBoxKey(evidence) || `flow:${sourcePosition}`
  return structId('block', `${sourceSha256}:${kind}:${position}:${text}`)
}

function tableFromNode(
  node: Extract<ResearchNode, { type: 'figure' }>,
  evidenceId: string,
  resolveEndpoint: (id: string) => string,
  resolveRelationship: (id: string) => string,
): StructTable | undefined {
  if (!node.table) return undefined
  const cells: StructTableCell[] = []
  let maxColumns = 0
  node.table.rows.forEach((row, rowIndex) => {
    let column = 0
    for (const [cellIndex, cell] of row.cells.entries()) {
      const sourceRuns = cell.sourceRuns ?? []
      const cellEvidence: StructEvidence = sourceRuns.length
        ? {
            confidence: 1,
            pages: [...new Set(sourceRuns.map((run) => run.box.page))],
            boxes: sourceRuns.map(({ box }) => ({
              page: box.page,
              x: box.x,
              y: box.y,
              width: box.width,
              height: box.height,
              rotation: box.rotation,
            })),
            sourceIds: sourceRuns.flatMap(({ regionId, lineId }) => [
              regionId,
              lineId,
            ]),
          }
        : { confidence: 0, pages: [], boxes: [], sourceIds: [evidenceId] }
      const id =
        cell.id ??
        structId('cell', `${evidenceId}:${rowIndex}:${cellIndex}:${cell.text}`)
      cells.push({
        id,
        text: cell.text,
        row: rowIndex,
        column,
        rowSpan: cell.rowSpan,
        columnSpan: cell.columnSpan,
        headerScope: cell.headerScope,
        inline: [
          ...(cell.inlineRuns ?? []).map((run) => ({
            start: run.start,
            end: run.end,
            ...(run.href ? { href: run.href } : {}),
            ...(run.annotationId ? { annotationId: run.annotationId } : {}),
            ...(run.relationshipId
              ? { relationshipId: resolveRelationship(run.relationshipId) }
              : {}),
            ...(run.targetIds
              ? { targetIds: run.targetIds.map(resolveEndpoint) }
              : {}),
            ...(run.bold ? { bold: true } : {}),
            ...(run.italic ? { italic: true } : {}),
            ...(run.verticalAlign ? { verticalAlign: run.verticalAlign } : {}),
            ...(run.semanticRole ? { semanticRole: run.semanticRole } : {}),
          })),
          ...(cell.noteReferences ?? []).map((reference) => ({
            start: reference.start,
            end: reference.end,
            href: `#${resolveEndpoint(reference.target)}`,
            relationshipId: resolveRelationship(reference.id),
            targetIds: [resolveEndpoint(reference.target)],
            semanticRole: 'note-reference' as const,
          })),
        ].sort(
          (left, right) =>
            left.start - right.start ||
            left.end - right.end ||
            String(left.relationshipId ?? '').localeCompare(
              String(right.relationshipId ?? ''),
            ),
        ),
        evidence: cellEvidence,
      })
      column += cell.columnSpan
    }
    maxColumns = Math.max(maxColumns, column)
  })
  return {
    rows: node.table.rows.length,
    columns: maxColumns,
    cells,
    semantic: node.objectType === 'table' ? 'verified' : 'source-preserved',
  }
}

function regionEvidence(region: PdfPageRegion): StructEvidence {
  return {
    confidence: region.confidence,
    pages: [region.page],
    boxes: [
      {
        page: region.box.page,
        x: region.box.x,
        y: region.box.y,
        width: region.box.width,
        height: region.box.height,
        rotation: region.box.rotation,
      },
    ],
    sourceIds: [region.id, ...region.lines.map((line) => line.id)],
  }
}

function regionStructKind(region: PdfPageRegion): StructBlockKind {
  if (region.furniture) return 'furniture'
  return region.kind === 'figure'
    ? 'figure'
    : region.kind === 'equation'
      ? 'equation'
      : region.kind === 'caption'
        ? 'caption'
        : region.kind === 'footnote'
          ? 'footnote'
          : 'paragraph'
}

function furnitureEvidence(
  evidence: PdfPageRegion['furniture'],
): StructFurnitureEvidence | undefined {
  if (!evidence) return undefined
  return {
    classification: evidence.classification,
    band: evidence.band,
    pages: [...evidence.pages],
    boxes: evidence.boxes.map(({ page, x, y, width, height, rotation }) => ({
      page,
      x,
      y,
      width,
      height,
      rotation,
    })),
    evidence: [...evidence.evidence],
    ...(evidence.normalizedText
      ? { normalizedText: evidence.normalizedText }
      : {}),
    ...(evidence.sequence ? { sequence: [...evidence.sequence] } : {}),
    ...(evidence.sourceRunIndexes
      ? { sourceRunIndexes: [...evidence.sourceRunIndexes] }
      : {}),
  }
}

function furnitureReview(
  review: PdfPageRegion['furnitureReview'],
): StructFurnitureReview | undefined {
  if (!review) return undefined
  return {
    reason: review.reason,
    band: review.band,
    pages: [...review.pages],
    boxes: review.boxes.map(({ page, x, y, width, height, rotation }) => ({
      page,
      x,
      y,
      width,
      height,
      rotation,
    })),
    evidence: [...review.evidence],
  }
}

export function buildStructDocument(
  reconstruction: DocumentReconstruction,
): StructDocument {
  const pdf = isPdf(reconstruction)
  const provenance = reconstruction.provenance ?? {}
  const sourceToStructId = new Map<string, string>()
  const tableCellAnchorIds = new Set<string>()
  const fallbackRegionIds = new Set<string>()
  for (const [sourcePosition, node] of reconstruction.paper.nodes.entries()) {
    const evidence = boxEvidence(provenance[node.id], node.id)
    const blockId = stableBlockId({
      sourceSha256: reconstruction.source.sha256,
      kind: nodeKind(node),
      text: nodeText(node),
      evidence,
      sourcePosition,
    })
    sourceToStructId.set(node.id, blockId)
    if (node.type === 'figure' && node.table) {
      node.table.rows.forEach((row, rowIndex) => {
        row.cells.forEach((cell, cellIndex) => {
          const tableCellAnchorId = `${node.id}:table:${cell.id ?? `${rowIndex}:${cellIndex}`}`
          sourceToStructId.set(tableCellAnchorId, blockId)
          tableCellAnchorIds.add(tableCellAnchorId)
        })
      })
    }
    for (const regionId of provenance[node.id]?.regionIds ?? []) {
      if (!sourceToStructId.has(regionId)) {
        sourceToStructId.set(regionId, blockId)
      }
    }
  }
  if (pdf) {
    for (const [sourcePosition, region] of reconstruction.regions.entries()) {
      if (!sourceToStructId.has(region.id)) {
        fallbackRegionIds.add(region.id)
        sourceToStructId.set(
          region.id,
          stableBlockId({
            sourceSha256: reconstruction.source.sha256,
            kind: regionStructKind(region),
            text: region.text,
            evidence: regionEvidence(region),
            sourcePosition,
          }),
        )
      }
    }
  }
  const resolveEndpoint = (id: string) => sourceToStructId.get(id) ?? id
  const noteOwner = (
    note: DocumentReconstruction['noteRelationships'][number],
  ) =>
    note.canonicalAnchor?.kind === 'node'
      ? resolveEndpoint(note.canonicalAnchor.nodeId)
      : resolveEndpoint(note.referenceRegionId)
  const noteIdentityOwner = (
    note: DocumentReconstruction['noteRelationships'][number],
  ) =>
    note.canonicalAnchor?.kind === 'node' &&
    tableCellAnchorIds.has(note.canonicalAnchor.nodeId)
      ? `${noteOwner(note)}:${note.canonicalAnchor.nodeId}`
      : noteOwner(note)
  const sourceRelationshipIds = new Map<string, string>()
  for (const note of reconstruction.noteRelationships) {
    sourceRelationshipIds.set(
      note.id,
      structId(
        'relationship',
        `${reconstruction.source.sha256}:note:${noteIdentityOwner(note)}:${note.referenceStart}:${note.referenceEnd}:${note.label}`,
      ),
    )
  }
  if (pdf) {
    for (const citation of reconstruction.citationRelationships) {
      const owner = resolveEndpoint(
        citation.canonicalAnchor?.nodeId ?? citation.referenceRegionId,
      )
      sourceRelationshipIds.set(
        citation.id,
        structId(
          'relationship',
          `${reconstruction.source.sha256}:citation:${owner}:${citation.referenceStart}:${citation.referenceEnd}:${citation.label}`,
        ),
      )
    }
    for (const crossReference of reconstruction.crossReferenceRelationships) {
      const owner = resolveEndpoint(
        crossReference.canonicalAnchor?.nodeId ??
          crossReference.referenceRegionId,
      )
      sourceRelationshipIds.set(
        crossReference.id,
        structId(
          'relationship',
          `${reconstruction.source.sha256}:cross-reference:${owner}:${crossReference.referenceStart}:${crossReference.referenceEnd}:${crossReference.text}`,
        ),
      )
    }
  }
  const resolveRelationship = (id: string) =>
    sourceRelationshipIds.get(id) ?? id
  const assetIds = new Map(
    reconstruction.assets.map((asset, sourcePosition) => {
      const evidence: StructEvidence = {
        confidence: 1,
        pages: [...new Set(asset.sourceBoxes.map((box) => box.page))],
        boxes: asset.sourceBoxes.map(
          ({ page, x, y, width, height, rotation }) => ({
            page,
            x,
            y,
            width,
            height,
            rotation,
          }),
        ),
        sourceIds: [...asset.sourceObjectIds],
      }
      const position = stableBoxKey(evidence) || `asset:${sourcePosition}`
      return [
        asset.id,
        structId(
          'asset',
          `${reconstruction.source.sha256}:${asset.kind}:${position}:${asset.sha256}`,
        ),
      ] as const
    }),
  )
  const resolveAsset = (id: string) => assetIds.get(id) ?? id
  const resolveGraphEndpoint = (id: string) =>
    sourceToStructId.get(id) ?? assetIds.get(id) ?? id
  const visualByNode = new Map(
    reconstruction.visualRelationships.map((relationship) => [
      relationship.canonicalNodeId ??
        relationship.captionNodeId ??
        relationship.id,
      relationship,
    ]),
  )
  const blocks = reconstruction.paper.nodes.map((node, order): StructBlock => {
    const evidenceId = node.id
    const evidence = boxEvidence(provenance[node.id], evidenceId)
    const visual = visualByNode.get(node.id)
    const kind = nodeKind(node)
    const text = nodeText(node)
    const table =
      node.type === 'figure'
        ? tableFromNode(node, evidenceId, resolveEndpoint, resolveRelationship)
        : undefined
    return {
      id: resolveEndpoint(node.id),
      kind,
      text,
      ...(node.type === 'figure' ? { label: node.title } : {}),
      page: evidence.pages[0] ?? null,
      order,
      column: null,
      inline: inlineRuns(node, resolveEndpoint, resolveRelationship),
      evidence,
      ...(table ? { table } : {}),
      ...(() => {
        const fallbackAssetIds =
          visual?.assetIds ??
          (node.type === 'figure' ? (node.relationships.assets ?? []) : [])
        return fallbackAssetIds.length > 0
          ? { fallbackAssetIds: fallbackAssetIds.map(resolveAsset) }
          : {}
      })(),
      attributes: {
        ...(node.type === 'heading' ? { level: node.level } : {}),
        ...(node.type === 'paragraph' && node.list
          ? {
              listLevel: node.list.level,
              listOrdered: node.list.ordered,
              ...(node.list.numberingId === 'references'
                ? { bibliographyEntry: true }
                : {}),
              ...(node.list.ordinal ? { listOrdinal: node.list.ordinal } : {}),
            }
          : {}),
        ...(node.type === 'figure' && node.objectType
          ? { objectType: node.objectType }
          : {}),
      },
    }
  })
  const regionBlocks = pdf
    ? reconstruction.regions
        .filter((region) => fallbackRegionIds.has(region.id))
        .map(
          (region, index) =>
            ({
              id: resolveEndpoint(region.id),
              kind: regionStructKind(region),
              text: region.text,
              page: region.page,
              order:
                reconstruction.readingOrder.order.indexOf(region.id) >= 0
                  ? reconstruction.readingOrder.order.indexOf(region.id)
                  : reconstruction.paper.nodes.length + index,
              column: region.column,
              inline: [],
              evidence: regionEvidence(region),
              ...(region.furniture
                ? { furniture: furnitureEvidence(region.furniture) }
                : {}),
              ...(region.furnitureReview
                ? { furnitureReview: furnitureReview(region.furnitureReview) }
                : {}),
              attributes: {},
            }) satisfies StructBlock,
        )
    : []
  const allBlocks = [...blocks, ...regionBlocks]
  const assets: StructAsset[] = reconstruction.assets.map((asset) => {
    const kind =
      asset.kind === 'table'
        ? 'table'
        : asset.kind === 'equation'
          ? 'equation'
          : asset.kind === 'vector'
            ? 'diagram'
            : 'figure'
    const evidence: StructEvidence = {
      confidence: 1,
      pages: [...new Set(asset.sourceBoxes.map((box) => box.page))],
      boxes: asset.sourceBoxes.map(
        ({ page, x, y, width, height, rotation }) => ({
          page,
          x,
          y,
          width,
          height,
          rotation,
        }),
      ),
      sourceIds: [...asset.sourceObjectIds],
    }
    return {
      id: resolveAsset(asset.id),
      kind,
      href: asset.href,
      mediaType: asset.mediaType,
      sha256: asset.sha256,
      width: asset.width,
      height: asset.height,
      bytes: asset.bytes,
      sourceObjectIds: [...asset.sourceObjectIds],
      evidence,
      fallback:
        asset.rendition === 'source-page-crop' ||
        asset.rendition === 'bounded-svg-fallback'
          ? 'source-region'
          : 'asset',
    }
  })
  const relationships: StructRelationship[] = []
  for (const visual of reconstruction.visualRelationships) {
    const from = resolveGraphEndpoint(
      visual.canonicalNodeId ??
        visual.captionNodeId ??
        visual.sourceRegionIds[0] ??
        visual.assetIds[0] ??
        visual.id,
    )
    relationships.push({
      id: structId(
        'relationship',
        `${reconstruction.source.sha256}:${visual.kind}:${from}:${visual.assetIds.map(resolveAsset).join(',')}:${visual.label}:${visual.status}`,
      ),
      kind: visual.kind,
      from,
      to: [
        ...visual.assetIds.map(resolveAsset),
        ...(visual.captionNodeId
          ? [resolveEndpoint(visual.captionNodeId)]
          : []),
      ],
      label: visual.label,
      status: visual.status === 'matched' ? 'matched' : visual.status,
      confidence: visual.confidence,
      evidence: {
        confidence: visual.confidence,
        pages: [...new Set(visual.sourceBoxes.map((box) => box.page))],
        boxes: visual.sourceBoxes.map(
          ({ page, x, y, width, height, rotation }) => ({
            page,
            x,
            y,
            width,
            height,
            rotation,
          }),
        ),
        sourceIds: [...visual.sourceRegionIds, ...visual.sourceObjectIds],
      },
    })
  }
  for (const note of reconstruction.noteRelationships) {
    if (
      note.status === 'citation' &&
      pdf &&
      reconstruction.citationRelationships.some(
        (citation) => citation.id === note.id,
      )
    ) {
      continue
    }
    const candidates = note.candidates.map((candidate) => ({
      target: resolveEndpoint(candidate.targetNoteId),
      confidence: candidate.score,
      evidence: {
        confidence: candidate.score,
        pages: [...new Set(candidate.sourceBoxes.map((box) => box.page))],
        boxes: candidate.sourceBoxes.map(
          ({ page, x, y, width, height, rotation }) => ({
            page,
            x,
            y,
            width,
            height,
            rotation,
          }),
        ),
        sourceIds: [
          note.referenceRegionId,
          candidate.targetRegionId,
          candidate.targetNoteId,
        ],
        signals: [...candidate.evidence],
      },
    }))
    const targetIds = note.targetNoteId
      ? [resolveEndpoint(note.targetNoteId)]
      : []
    const candidateTargetKinds = new Set(
      candidates.map(
        (candidate) =>
          blocks.find((block) => block.id === candidate.target)?.kind,
      ),
    )
    const noteKind =
      targetIds.some(
        (target) =>
          blocks.find((block) => block.id === target)?.kind === 'endnote',
      ) ||
      (targetIds.length === 0 &&
        candidateTargetKinds.size === 1 &&
        candidateTargetKinds.has('endnote'))
        ? 'endnote'
        : 'footnote'
    const relationshipBoxes =
      note.status === 'ambiguous'
        ? [
            ...note.sourceBoxes,
            ...note.candidates.flatMap((candidate) => candidate.sourceBoxes),
          ]
        : note.sourceBoxes
    relationships.push({
      id: resolveRelationship(note.id),
      kind: note.status === 'citation' ? 'citation' : noteKind,
      from: noteOwner(note),
      to: targetIds,
      label: note.label,
      status:
        note.status === 'plain-text' || note.status === 'citation'
          ? note.status === 'citation'
            ? 'matched'
            : 'source-preserved'
          : note.status,
      confidence: note.confidence,
      evidence: {
        confidence: note.confidence,
        pages: [...new Set(relationshipBoxes.map((box) => box.page))],
        boxes: relationshipBoxes.map(
          ({ page, x, y, width, height, rotation }) => ({
            page,
            x,
            y,
            width,
            height,
            rotation,
          }),
        ),
        sourceIds: [
          note.referenceRegionId,
          ...(note.targetNoteId ? [note.targetNoteId] : []),
          ...note.candidates.flatMap((candidate) => [
            candidate.targetRegionId,
            candidate.targetNoteId,
          ]),
        ],
        signals: [...note.evidence],
      },
      ...(candidates.length > 0 ? { candidates } : {}),
    })
  }
  for (const block of blocks) {
    for (const [index, inline] of block.inline.entries()) {
      if (
        inline.semanticRole === 'citation' ||
        inline.semanticRole === 'cross-reference' ||
        inline.semanticRole === 'note-reference'
      ) {
        continue
      }
      if (!inline.href && !inline.targetIds?.length) continue
      const href = inline.href
      const targets = inline.targetIds ?? (href ? [href] : [])
      relationships.push({
        id: structId(
          'relationship',
          `hyperlink:${block.id}:${index}:${href ?? targets.join(',')}`,
        ),
        kind: 'hyperlink',
        from: block.id,
        to: targets,
        status:
          targets.length > 0 &&
          (!href || href.startsWith('#') || inline.targetIds?.length)
            ? 'matched'
            : 'source-preserved',
        confidence: block.evidence.confidence,
        evidence: {
          ...block.evidence,
          sourceIds: [
            ...block.evidence.sourceIds,
            ...(inline.annotationId ? [inline.annotationId] : []),
          ],
        },
      })
    }
  }
  const mappedAnnotationIds = new Set(
    blocks.flatMap((block) =>
      block.inline.flatMap((inline) =>
        inline.annotationId ? [inline.annotationId] : [],
      ),
    ),
  )
  for (const node of reconstruction.paper.nodes) {
    const owner = resolveEndpoint(node.id)
    for (const link of provenance[node.id]?.links ?? []) {
      if ('id' in link && link.id && mappedAnnotationIds.has(link.id)) continue
      const href = 'url' in link ? link.url : undefined
      const destination =
        'destination' in link && link.destination
          ? `#${link.destination}`
          : undefined
      const sourceId = 'id' in link && link.id ? link.id : `${owner}:link`
      const box = link.box
      relationships.push({
        id: structId(
          'relationship',
          `annotation:${owner}:${href ?? destination ?? sourceId}`,
        ),
        kind: 'hyperlink',
        from: owner,
        to: href || destination ? [href ?? destination!] : [],
        status:
          'status' in link && link.status === 'unresolved'
            ? 'unresolved'
            : destination
              ? 'matched'
              : 'source-preserved',
        confidence: box ? 1 : 0,
        evidence: {
          confidence: box ? 1 : 0,
          pages: box ? [box.page] : [],
          boxes: box
            ? [
                {
                  page: box.page,
                  x: box.x,
                  y: box.y,
                  width: box.width,
                  height: box.height,
                  rotation: box.rotation,
                },
              ]
            : [],
          sourceIds: [sourceId],
        },
      })
    }
  }
  if (pdf) {
    for (const citation of reconstruction.citationRelationships) {
      const candidateNodeIds = citation.candidateNodeIds ?? []
      const owner = resolveEndpoint(
        citation.canonicalAnchor?.nodeId ?? citation.referenceRegionId,
      )
      relationships.push({
        id: resolveRelationship(citation.id),
        kind: 'citation',
        from: owner,
        to: citation.targetNodeIds.map(resolveEndpoint),
        label: citation.label,
        status: citation.status,
        confidence: citation.confidence,
        evidence: {
          confidence: citation.confidence,
          pages: [...new Set(citation.sourceBoxes.map((box) => box.page))],
          boxes: citation.sourceBoxes.map(
            ({ page, x, y, width, height, rotation }) => ({
              page,
              x,
              y,
              width,
              height,
              rotation,
            }),
          ),
          sourceIds: [
            citation.referenceRegionId,
            ...citation.targetNodeIds,
            ...candidateNodeIds,
          ],
          signals: [...citation.evidence],
        },
        ...(candidateNodeIds.length > 0
          ? {
              candidates: candidateNodeIds.map((targetNodeId) => {
                const target = resolveEndpoint(targetNodeId)
                const targetEvidence = blocks.find(
                  (block) => block.id === target,
                )?.evidence
                return {
                  target,
                  confidence: citation.confidence,
                  evidence: targetEvidence
                    ? {
                        ...targetEvidence,
                        sourceIds: [
                          citation.referenceRegionId,
                          ...targetEvidence.sourceIds,
                        ],
                        signals: [...citation.evidence],
                      }
                    : {
                        confidence: citation.confidence,
                        pages: [],
                        boxes: [],
                        sourceIds: [citation.referenceRegionId, targetNodeId],
                        signals: [...citation.evidence],
                      },
                }
              }),
            }
          : {}),
      })
    }
    for (const crossReference of reconstruction.crossReferenceRelationships) {
      const candidateNodeIds = [
        ...new Set(
          crossReference.targets.flatMap((target) => target.candidateNodeIds),
        ),
      ]
      relationships.push({
        id: resolveRelationship(crossReference.id),
        kind: 'cross-reference',
        from: resolveEndpoint(
          crossReference.canonicalAnchor?.nodeId ??
            crossReference.referenceRegionId,
        ),
        to: crossReference.targetNodeIds.map(resolveEndpoint),
        label: crossReference.text,
        status: crossReference.status,
        confidence: crossReference.confidence,
        evidence: {
          confidence: crossReference.confidence,
          pages: [
            ...new Set(crossReference.sourceBoxes.map((box) => box.page)),
          ],
          boxes: crossReference.sourceBoxes.map(
            ({ page, x, y, width, height, rotation }) => ({
              page,
              x,
              y,
              width,
              height,
              rotation,
            }),
          ),
          sourceIds: [
            crossReference.referenceRegionId,
            ...crossReference.targetNodeIds,
            ...candidateNodeIds,
          ],
          signals: [...crossReference.evidence],
        },
        ...(candidateNodeIds.length > 0
          ? {
              candidates: candidateNodeIds.map((targetNodeId) => ({
                target: resolveEndpoint(targetNodeId),
                confidence: crossReference.confidence,
                evidence: {
                  confidence: crossReference.confidence,
                  pages: [
                    ...new Set(
                      crossReference.sourceBoxes.map((box) => box.page),
                    ),
                  ],
                  boxes: crossReference.sourceBoxes.map(
                    ({ page, x, y, width, height, rotation }) => ({
                      page,
                      x,
                      y,
                      width,
                      height,
                      rotation,
                    }),
                  ),
                  sourceIds: [crossReference.referenceRegionId, targetNodeId],
                  signals: [
                    ...new Set(
                      crossReference.targets
                        .filter((target) =>
                          target.candidateNodeIds.includes(targetNodeId),
                        )
                        .flatMap((target) => target.evidence),
                    ),
                  ],
                },
              })),
            }
          : {}),
      })
    }
    for (const edge of reconstruction.readingOrder.edges) {
      relationships.push({
        id: structId(
          'relationship',
          `${reconstruction.source.sha256}:reading-order:${resolveEndpoint(edge.from)}:${resolveEndpoint(edge.to)}:${edge.status}`,
        ),
        kind: 'reading-order',
        from: resolveEndpoint(edge.from),
        to: [resolveEndpoint(edge.to)],
        status: edge.status === 'accepted' ? 'matched' : 'ambiguous',
        confidence: edge.confidence,
        evidence: {
          confidence: edge.confidence,
          pages: [...new Set(edge.sourceBoxes.map((box) => box.page))],
          boxes: edge.sourceBoxes.map(
            ({ page, x, y, width, height, rotation }) => ({
              page,
              x,
              y,
              width,
              height,
              rotation,
            }),
          ),
          sourceIds: [edge.from, edge.to],
        },
      })
    }
  }
  const diagnostics = reconstruction.diagnostics.map((diagnostic) =>
    toStructDiagnostic({
      id: structId(
        'diagnostic',
        `${reconstruction.source.sha256}:${diagnostic.code}:${diagnostic.page ?? 'document'}:${diagnostic.message}:${(diagnostic.target?.regionIds ?? []).join(',')}:${diagnostic.relationshipId ?? ''}`,
      ),
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
      page: diagnostic.page,
      sourceIds: [
        ...(diagnostic.target?.regionIds ?? []),
        ...(diagnostic.relationshipId ? [diagnostic.relationshipId] : []),
      ],
    }),
  )
  const pageInputs = pdf
    ? reconstruction.pages.map((page) => ({
        page: page.page,
        width: page.width,
        height: page.height,
        rotation: page.rotation,
      }))
    : []
  const orderedBlocks = orderBlocksByLayout(allBlocks)
  const pages = pageLayoutsFromBlocks(pageInputs, orderedBlocks)
  const recovery = recoverySummary({
    ready: reconstruction.readiness.ready,
    diagnostics: recoveryDiagnosticInputs(reconstruction),
    blockingCodes: reconstruction.readiness.blockingDiagnosticCodes,
    textCoverage: reconstruction.completeness.textCoverage,
    assetCoverage: reconstruction.completeness.assetCoverage,
    relationshipCoverage: reconstruction.completeness.relationshipCoverage,
    unresolvedObjectCount: reconstruction.completeness.unresolvedObjectCount,
  })
  const source = {
    format: sourceFormat(reconstruction),
    fileName: reconstruction.source.fileName,
    sha256: reconstruction.source.sha256,
    byteLength: reconstruction.source.byteLength,
    pageCount: reconstruction.source.pageCount,
    localOnly: reconstruction.source.localOnly,
  } as const
  const metadata = {
    title: reconstruction.paper.title,
    subtitle: reconstruction.paper.subtitle,
    authors: [...reconstruction.paper.authors],
    abstract: reconstruction.paper.abstract,
    ...(reconstruction.paper.language
      ? { language: reconstruction.paper.language }
      : {}),
    ...(reconstruction.paper.baseDirection
      ? { baseDirection: reconstruction.paper.baseDirection }
      : {}),
    ...(reconstruction.paper.publicationDate
      ? { publicationDate: reconstruction.paper.publicationDate }
      : {}),
    ...(reconstruction.paper.artifactModifiedAt
      ? { artifactModifiedAt: reconstruction.paper.artifactModifiedAt }
      : {}),
    ...(reconstruction.paper.updated
      ? { updated: reconstruction.paper.updated }
      : {}),
    ...(reconstruction.paper.affiliations
      ? { affiliations: [...reconstruction.paper.affiliations] }
      : {}),
    ...(reconstruction.paper.authorAffiliations
      ? {
          authorAffiliations: reconstruction.paper.authorAffiliations.map(
            (affiliation) => ({ ...affiliation }),
          ),
        }
      : {}),
    ...(reconstruction.paper.authorNotes
      ? {
          authorNotes: reconstruction.paper.authorNotes.map((reference) => ({
            id: resolveRelationship(reference.id),
            author: reference.author,
            label: reference.label,
            target: resolveEndpoint(reference.target),
          })),
        }
      : {}),
  }
  const sourceRegionIds = new Set(
    pdf ? reconstruction.regions.map((region) => region.id) : [],
  )
  const accountedSourceRegionCount = new Set(
    orderedBlocks.flatMap((block) =>
      block.evidence.sourceIds.filter((sourceId) =>
        sourceRegionIds.has(sourceId),
      ),
    ),
  ).size
  const sourceAnnotationCount = reconstruction.paper.nodes.reduce(
    (count, node) => count + (provenance[node.id]?.links.length ?? 0),
    0,
  )
  const sourceRelationshipCount =
    reconstruction.visualRelationships.length +
    reconstruction.noteRelationships.length +
    sourceAnnotationCount +
    (pdf
      ? reconstruction.citationRelationships.length +
        reconstruction.crossReferenceRelationships.length +
        reconstruction.readingOrder.edges.length
      : 0)
  const sourceTextCharacterCount =
    reconstruction.paper.nodes.reduce(
      (count, node) => count + nodeText(node).length,
      0,
    ) + regionBlocks.reduce((count, block) => count + block.text.length, 0)
  const structTextCharacterCount = orderedBlocks.reduce(
    (count, block) => count + block.text.length,
    0,
  )
  const furnitureBlocks = orderedBlocks.filter(
    (block) => block.kind === 'furniture',
  )
  const furnitureTextCharacterCount = furnitureBlocks.reduce(
    (count, block) => count + block.text.length,
    0,
  )
  const conservation = {
    sourceNodeCount: reconstruction.paper.nodes.length,
    accountedSourceNodeCount: blocks.length,
    sourceRegionCount: pdf ? reconstruction.regions.length : 0,
    accountedSourceRegionCount,
    sourceAnnotationCount,
    accountedSourceAnnotationCount: sourceAnnotationCount,
    sourceAssetCount: reconstruction.assets.length,
    accountedSourceAssetCount: assets.length,
    sourceRelationshipCount,
    accountedSourceRelationshipCount: sourceRelationshipCount,
    sourceDiagnosticCount: reconstruction.diagnostics.length,
    accountedSourceDiagnosticCount: diagnostics.length,
    sourceTextCharacterCount,
    structBlockCount: orderedBlocks.length,
    structAssetCount: assets.length,
    structRelationshipCount: relationships.length,
    structDiagnosticCount: diagnostics.length,
    structTextCharacterCount,
    ...(furnitureBlocks.length > 0
      ? {
          sourceFurnitureBlockCount: reconstruction.regions.filter(
            (region) => region.furniture,
          ).length,
          accountedFurnitureBlockCount: furnitureBlocks.length,
          sourceFurnitureTextCharacterCount: reconstruction.regions
            .filter((region) => region.furniture)
            .reduce((count, region) => count + region.text.length, 0),
          structFurnitureBlockCount: furnitureBlocks.length,
          structFurnitureTextCharacterCount: furnitureTextCharacterCount,
        }
      : {}),
    ...(reconstruction.completeness.furnitureContaminationCount !== undefined
      ? {
          furnitureContaminationCount:
            reconstruction.completeness.furnitureContaminationCount,
        }
      : {}),
  }
  const canonicalAssets = [...assets].sort((left, right) =>
    left.id.localeCompare(right.id),
  )
  const canonicalRelationships = [...relationships].sort((left, right) =>
    left.id.localeCompare(right.id),
  )
  const canonicalDiagnostics = [...diagnostics].sort((left, right) =>
    left.id.localeCompare(right.id),
  )
  const withoutReceipt = {
    schemaVersion: '0.1.0' as const,
    source,
    metadata,
    blocks: orderedBlocks,
    assets: canonicalAssets,
    relationships: canonicalRelationships,
    pages,
    diagnostics: canonicalDiagnostics,
    recovery,
  }
  const generatedSha256 = structDigest({
    ...withoutReceipt,
    conservation,
    assets: canonicalAssets.map(({ bytes: _bytes, ...asset }) => asset),
  })
  return {
    ...withoutReceipt,
    receipt: {
      schemaVersion: '0.1.0',
      sourceSha256: source.sha256,
      blockCount: orderedBlocks.length,
      assetCount: assets.length,
      relationshipCount: relationships.length,
      diagnosticCount: diagnostics.length,
      textCharacterCount: sourceTextCharacterCount,
      conservation,
      generatedSha256,
    },
  }
}
