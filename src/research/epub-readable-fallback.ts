import { strFromU8 } from 'fflate'
import {
  PdfImportError,
  type PdfPageAnalysis,
  type PdfReconstruction,
  type PublicationAsset,
  type PublicationVisualRelationship,
} from './import-types'
import { renderableAuthorNoteReferences } from './publication-integrity'
import {
  MAX_EPUB_ASSET_BYTES_PER_BOOK,
  MAX_EPUB_ASSETS_PER_BOOK,
} from './publication-resource-limits'
import {
  hasValidatedSourcePageRenderAsset,
  validatedPdfVisualRelationships,
} from './pdf-visual-validation'
import type { ResearchPaper } from './schema'

export const MAX_READABLE_FALLBACK_ASSETS_PER_VISUAL = 16
const MAX_READABLE_FALLBACK_OPTIONAL_ASSETS_PER_BOOK = 64
export const MAX_READABLE_FALLBACK_EQUATIONS_PER_BOOK = 512

export function duplicateVisualRelationshipNodeOwnership(
  relationships: readonly PublicationVisualRelationship[],
) {
  for (const field of ['canonicalNodeId', 'captionNodeId'] as const) {
    const ownersByNodeId = new Map<string, string[]>()
    for (const relationship of relationships) {
      const nodeId = relationship[field]
      if (!nodeId) continue
      const owners = ownersByNodeId.get(nodeId) ?? []
      owners.push(relationship.id)
      ownersByNodeId.set(nodeId, owners)
    }
    for (const [nodeId, relationshipIds] of ownersByNodeId) {
      if (relationshipIds.length > 1) {
        return { field, nodeId, relationshipIds }
      }
    }
  }
  return null
}

export function epubAssetResourceUsage(assets: readonly PublicationAsset[]) {
  const bytes = assets.reduce((total, asset) => {
    const byteLength = asset.bytes?.byteLength
    return Number.isSafeInteger(byteLength) && byteLength >= 0
      ? total + byteLength
      : Number.POSITIVE_INFINITY
  }, 0)
  return { count: assets.length, bytes }
}

export function epubAssetResourceLimitMessage({
  equationCount,
  assetCount,
  assetBytes,
}: {
  equationCount?: number
  assetCount: number
  assetBytes: number
}) {
  return `EPUB asset resource limit exceeded: ${equationCount === undefined ? '' : `${equationCount} matched equations, `}${assetCount} assets and ${assetBytes} source bytes; bounded limits are ${MAX_READABLE_FALLBACK_EQUATIONS_PER_BOOK} matched equations, ${MAX_EPUB_ASSETS_PER_BOOK} assets and ${MAX_EPUB_ASSET_BYTES_PER_BOOK} source bytes.`
}

export function validNoteReferences<
  Reference extends {
    id: string
    target: string
    start: number
    end: number
  },
>(value: string, references?: Reference[]) {
  return (references ?? []).filter(
    (reference) =>
      reference.start >= 0 &&
      reference.start < reference.end &&
      reference.end <= value.length,
  )
}
function hasReadableText(paper: ResearchPaper) {
  return paper.nodes.some((node) => {
    if ('text' in node) return node.text.trim().length > 0
    return node.type === 'figure' && node.title.trim().length > 0
  })
}

function sourcePreservedOcrFallback(
  reconstruction: PdfReconstruction,
  readableProjection: PdfReconstruction,
): PdfReconstruction | undefined {
  const requiredPages = reconstruction.completeness.ocrRequiredPages
  if (reconstruction.pages.length === 0 || requiredPages.length === 0) {
    return undefined
  }

  const selected = requiredPages.map((pageNumber) => {
    const page = reconstruction.pages.find(
      (candidate) => candidate.page === pageNumber,
    )
    if (!page) return undefined
    const candidates = (page.assets ?? []).filter((asset) => {
      if (
        asset.kind !== 'raster' ||
        asset.rendition !== 'source-page-render' ||
        asset.mediaType !== 'image/png' ||
        asset.bytes.byteLength === 0 ||
        asset.sourceObjectIds.length !== 1 ||
        asset.sourceBoxes.length !== 1
      ) {
        return false
      }
      const sourceBox = asset.sourceBoxes[0]
      const sourceObject = page.objects?.find(
        (object) =>
          object.id === asset.sourceObjectIds[0] &&
          object.assetId === asset.id &&
          object.kind === 'image' &&
          object.role === 'scan-source' &&
          object.rolePolicy === 'pdfjs-complete-page-render-v1',
      )
      return (
        sourceObject !== undefined &&
        hasValidatedSourcePageRenderAsset(sourceObject, page.assets) &&
        sourceBox.page === page.page &&
        sourceObject.box.page === page.page &&
        sourceBox.x === sourceObject.box.x &&
        sourceBox.y === sourceObject.box.y &&
        sourceBox.width === sourceObject.box.width &&
        sourceBox.height === sourceObject.box.height &&
        sourceBox.rotation === sourceObject.box.rotation &&
        sourceBox.x === 0 &&
        sourceBox.y === 0 &&
        sourceBox.width === 1 &&
        sourceBox.height === 1 &&
        sourceObject.box.x === 0 &&
        sourceObject.box.y === 0 &&
        sourceObject.box.width === 1 &&
        sourceObject.box.height === 1
      )
    })
    return candidates.length === 1 ? { page, asset: candidates[0]! } : undefined
  })
  if (selected.some((candidate) => candidate === undefined)) return undefined
  const selectedPages = selected as Array<{
    page: PdfPageAnalysis
    asset: PublicationAsset
  }>
  const projectedAssets = new Map(
    [
      ...readableProjection.assets,
      ...selectedPages.map(({ asset }) => asset),
    ].map((asset) => [asset.id, asset]),
  )
  const usage = epubAssetResourceUsage([...projectedAssets.values()])
  if (
    usage.count > MAX_EPUB_ASSETS_PER_BOOK ||
    usage.bytes > MAX_EPUB_ASSET_BYTES_PER_BOOK
  ) {
    return undefined
  }

  const fallbackNodes: Array<{
    page: number
    nodes: ResearchPaper['nodes']
  }> = []
  const provenance = { ...readableProjection.provenance }
  const relationships: PublicationVisualRelationship[] = [
    ...readableProjection.visualRelationships,
  ]
  const regions = [...readableProjection.regions]
  for (const { page, asset } of selectedPages) {
    const suffix = String(page.page).padStart(3, '0')
    const nodeId = `source-scan-page-${suffix}`
    const captionNodeId = `${nodeId}-caption`
    const captionRegionId = `${nodeId}-caption-region`
    const title = `Source page ${page.page} — text recovery required.`
    const sourceBox = asset.sourceBoxes[0]!
    fallbackNodes.push({
      page: page.page,
      nodes: [
        {
          id: nodeId,
          type: 'figure',
          title,
          relationships: { caption: captionNodeId, assets: [asset.id] },
          source: `pdf:${reconstruction.source.sha256}#page=${page.page}`,
        },
        {
          id: captionNodeId,
          type: 'caption',
          text: title,
          source: `pdf:${reconstruction.source.sha256}#page=${page.page}`,
        },
      ],
    })
    provenance[nodeId] = {
      confidence: 0,
      pages: [page.page],
      regionIds: [],
      boxes: [sourceBox],
      links: [],
    }
    provenance[captionNodeId] = {
      confidence: 0,
      pages: [page.page],
      regionIds: [captionRegionId],
      boxes: [sourceBox],
      links: [],
    }
    regions.push({
      id: captionRegionId,
      page: page.page,
      kind: 'caption',
      column: 'span',
      text: title,
      confidence: 0,
      box: sourceBox,
      lines: [],
      nativeObjectIds: [...asset.sourceObjectIds],
      includedInReadingOrder: false,
    })
    relationships.push({
      id: `${nodeId}-relationship`,
      kind: 'figure',
      label: `Source page ${page.page}`,
      captionRegionId,
      sourceRegionIds: [],
      sourceLineIds: [],
      sourceObjectIds: [...asset.sourceObjectIds],
      assetIds: [asset.id],
      status: 'unresolved',
      confidence: 0,
      evidence: [
        'source-preserved-unresolved-page-fallback',
        'pdfjs-complete-page-render-v1',
      ],
      candidates: [],
      sourceBoxes: [sourceBox],
      sourceText: '',
      altText: title,
      altTextSource: 'caption',
      canonicalNodeId: nodeId,
      captionNodeId,
    })
  }
  const nodes: ResearchPaper['nodes'] = []
  const pendingFallbackNodes = fallbackNodes.sort(
    (left, right) => left.page - right.page,
  )
  for (const node of readableProjection.paper.nodes) {
    const sourcePages = provenance[node.id]?.pages ?? []
    const sourcePage =
      sourcePages.length > 0
        ? Math.min(...sourcePages)
        : Number.POSITIVE_INFINITY
    while (
      pendingFallbackNodes[0] &&
      pendingFallbackNodes[0].page < sourcePage
    ) {
      nodes.push(...pendingFallbackNodes.shift()!.nodes)
    }
    nodes.push(node)
  }
  for (const fallback of pendingFallbackNodes) nodes.push(...fallback.nodes)
  return {
    ...readableProjection,
    paper: { ...readableProjection.paper, nodes },
    provenance,
    regions,
    visualRelationships: relationships,
    assets: [...projectedAssets.values()],
  }
}

function isSolidFillVectorFragment(asset: PublicationAsset) {
  if (
    asset.mediaType !== 'image/svg+xml' ||
    asset.bytes.length > 1024 ||
    !asset.sourceBoxes.some((box) => box.width >= 0.2 && box.height >= 0.1)
  ) {
    return false
  }
  const svg = strFromU8(asset.bytes)
  if (
    (svg.match(/<(?:path|rect)\b/g) ?? []).length !== 1 ||
    !/fill=["']#000(?:000)?["']/i.test(svg) ||
    !/stroke=["']none["']/i.test(svg)
  ) {
    return false
  }
  const viewBox = svg
    .match(/viewBox=["']([^"']+)["']/i)?.[1]
    ?.trim()
    .split(/\s+/)
    .map(Number)
  const path = svg.match(/<path\b[^>]*\bd=["']([^"']+)["']/i)?.[1]
  const coordinates = path?.match(/-?\d+(?:\.\d+)?/g)?.map(Number)
  if (
    !viewBox ||
    viewBox.length !== 4 ||
    !coordinates ||
    coordinates.length !== 8 ||
    !/^(?:\s*[ML]\s*-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?){4}\s*Z\s*$/i.test(path!)
  ) {
    return false
  }
  const [x, y, width, height] = viewBox
  const xs = coordinates.filter((_, index) => index % 2 === 0)
  const ys = coordinates.filter((_, index) => index % 2 === 1)
  const tolerance = Math.max(width, height) * 0.0001
  return (
    Math.abs(Math.min(...xs) - x) <= tolerance &&
    Math.abs(Math.max(...xs) - (x + width)) <= tolerance &&
    Math.abs(Math.min(...ys) - y) <= tolerance &&
    Math.abs(Math.max(...ys) - (y + height)) <= tolerance
  )
}

function projectRenderableNoteRelationships(
  paper: ResearchPaper,
): ResearchPaper {
  const footnoteIds = new Set(
    paper.nodes
      .filter((node) => node.type === 'footnote')
      .map((node) => node.id),
  )
  const seenReferenceIds = new Set<string>()
  const backlinksByTarget = new Map<string, string[]>()
  const retainReference = (reference: { id: string; target: string }) => {
    if (
      seenReferenceIds.has(reference.id) ||
      !footnoteIds.has(reference.target)
    ) {
      return false
    }
    seenReferenceIds.add(reference.id)
    const backlinks = backlinksByTarget.get(reference.target) ?? []
    backlinks.push(reference.id)
    backlinksByTarget.set(reference.target, backlinks)
    return true
  }

  const authorNotes =
    renderableAuthorNoteReferences(paper).filter(retainReference)
  const noteReferencesByNode = new Map<
    string,
    Array<{
      id: string
      label: string
      target: string
      start: number
      end: number
      confidence: number
    }>
  >()
  for (const node of paper.nodes) {
    if (!('noteReferences' in node) || !node.noteReferences) continue
    const references = validNoteReferences(
      node.text,
      node.noteReferences,
    ).filter(retainReference)
    noteReferencesByNode.set(node.id, references)
  }
  const noteReferencesByTableCell = new Map<
    string,
    Array<{
      id: string
      label: string
      target: string
      start: number
      end: number
      confidence: number
    }>
  >()
  for (const node of paper.nodes) {
    if (node.type !== 'figure' || !node.table) continue
    node.table.rows.forEach((row, rowIndex) => {
      row.cells.forEach((cell, cellIndex) => {
        if (!cell.noteReferences) return
        noteReferencesByTableCell.set(
          `${node.id}:${rowIndex}:${cellIndex}`,
          validNoteReferences(cell.text, cell.noteReferences).filter(
            retainReference,
          ),
        )
      })
    })
  }

  return {
    ...paper,
    authorNotes: paper.authorNotes ? authorNotes : undefined,
    nodes: paper.nodes.map((node) => {
      if (node.type === 'footnote') {
        return {
          ...node,
          ...(node.noteReferences
            ? { noteReferences: noteReferencesByNode.get(node.id) ?? [] }
            : {}),
          relationships: {
            ...node.relationships,
            backlinks: backlinksByTarget.get(node.id) ?? [],
          },
        }
      }
      if ('noteReferences' in node && node.noteReferences) {
        return {
          ...node,
          noteReferences: noteReferencesByNode.get(node.id) ?? [],
        }
      }
      if (node.type === 'figure' && node.table) {
        return {
          ...node,
          table: {
            ...node.table,
            rows: node.table.rows.map((row, rowIndex) => ({
              ...row,
              cells: row.cells.map((cell, cellIndex) =>
                cell.noteReferences
                  ? {
                      ...cell,
                      noteReferences:
                        noteReferencesByTableCell.get(
                          `${node.id}:${rowIndex}:${cellIndex}`,
                        ) ?? [],
                    }
                  : cell,
              ),
            })),
          },
        }
      }
      return node
    }),
  }
}

function projectReadableTextFallbackReconstruction(
  reconstruction: PdfReconstruction,
): PdfReconstruction {
  if (!hasReadableText(reconstruction.paper)) {
    throw new PdfImportError(
      'INCOMPLETE_RECONSTRUCTION',
      'A readable EPUB requires recovered text for every source page; run local OCR first.',
    )
  }
  const matchedEquationRelationships =
    reconstruction.visualRelationships.filter(
      (relationship) =>
        relationship.kind === 'equation' && relationship.status === 'matched',
    )
  const matchedEquationAssetIds = new Set(
    matchedEquationRelationships.flatMap(
      (relationship) => relationship.assetIds,
    ),
  )
  const matchedEquationAssets = reconstruction.assets.filter((asset) =>
    matchedEquationAssetIds.has(asset.id),
  )
  const equationAssetUsage = epubAssetResourceUsage(matchedEquationAssets)
  if (
    matchedEquationRelationships.length >
      MAX_READABLE_FALLBACK_EQUATIONS_PER_BOOK ||
    equationAssetUsage.count > MAX_EPUB_ASSETS_PER_BOOK ||
    equationAssetUsage.bytes > MAX_EPUB_ASSET_BYTES_PER_BOOK
  ) {
    throw new PdfImportError(
      'INCOMPLETE_RECONSTRUCTION',
      epubAssetResourceLimitMessage({
        equationCount: matchedEquationRelationships.length,
        assetCount: equationAssetUsage.count,
        assetBytes: equationAssetUsage.bytes,
      }),
    )
  }
  const duplicateVisualOwner = duplicateVisualRelationshipNodeOwnership(
    reconstruction.visualRelationships,
  )
  if (duplicateVisualOwner) {
    throw new PdfImportError(
      'INCOMPLETE_RECONSTRUCTION',
      `Readable EPUB reconstruction cannot retain visual relationships ${duplicateVisualOwner.relationshipIds.join(', ')} because they ambiguously share ${duplicateVisualOwner.field} ${duplicateVisualOwner.nodeId}.`,
    )
  }
  const availableAssetIds = new Set(
    reconstruction.assets
      .filter((asset) => !isSolidFillVectorFragment(asset))
      .map((asset) => asset.id),
  )
  const validatedRelationships = validatedPdfVisualRelationships({
    paper: reconstruction.paper,
    provenance: reconstruction.provenance,
    relationships: reconstruction.visualRelationships,
    assets: reconstruction.assets,
    regions: reconstruction.regions,
    pages: reconstruction.pages,
  })
  const validatedRelationshipsById = new Map(
    validatedRelationships.map((relationship) => [
      relationship.id,
      relationship,
    ]),
  )
  const selectedAssetIds = new Set<string>()
  const selectedOptionalAssetIds = new Set<string>()
  for (const relationship of matchedEquationRelationships) {
    if (
      !validatedRelationshipsById.has(relationship.id) ||
      relationship.assetIds.length > MAX_READABLE_FALLBACK_ASSETS_PER_VISUAL ||
      relationship.assetIds.some((assetId) => !availableAssetIds.has(assetId))
    ) {
      throw new PdfImportError(
        'INCOMPLETE_RECONSTRUCTION',
        `Readable EPUB reconstruction cannot retain matched equation relationship ${relationship.id} because its relationship or asset evidence is invalid.`,
      )
    }
    for (const assetId of relationship.assetIds) {
      selectedAssetIds.add(assetId)
    }
  }
  const captionNodeIds = new Set(
    reconstruction.paper.nodes
      .filter((node) => node.type === 'caption')
      .map((node) => node.id),
  )
  const retainedUnresolvedRelationshipIds = new Set(
    reconstruction.visualRelationships.flatMap((relationship) => {
      const withinPerVisualGuard =
        relationship.assetIds.length <= MAX_READABLE_FALLBACK_ASSETS_PER_VISUAL
      const assetsAvailable = relationship.assetIds.every((assetId) =>
        availableAssetIds.has(assetId),
      )
      if (
        relationship.status !== 'matched' &&
        relationship.canonicalNodeId &&
        withinPerVisualGuard &&
        assetsAvailable &&
        relationship.assetIds.length > 0 &&
        reconstruction.paper.nodes.some(
          (node) => node.id === relationship.canonicalNodeId,
        )
      ) {
        return [relationship.id]
      }
      if (
        relationship.status === 'matched' ||
        relationship.canonicalNodeId !== null ||
        relationship.assetIds.length > 0 ||
        !relationship.captionNodeId ||
        !captionNodeIds.has(relationship.captionNodeId)
      ) {
        return []
      }
      const captionProvenance =
        reconstruction.provenance[relationship.captionNodeId]
      return captionProvenance?.regionIds.includes(
        relationship.captionRegionId,
      ) && captionProvenance.boxes.length > 0
        ? [relationship.id]
        : []
    }),
  )
  const relationships = reconstruction.visualRelationships.flatMap(
    (relationship) => {
      const validated = validatedRelationshipsById.get(relationship.id)
      if (!validated) {
        if (retainedUnresolvedRelationshipIds.has(relationship.id)) {
          const newOptionalAssetIds = relationship.assetIds.filter(
            (assetId) => !selectedAssetIds.has(assetId),
          )
          if (
            selectedOptionalAssetIds.size + newOptionalAssetIds.length >
            MAX_READABLE_FALLBACK_OPTIONAL_ASSETS_PER_BOOK
          ) {
            return []
          }
          for (const assetId of relationship.assetIds) {
            selectedAssetIds.add(assetId)
          }
          for (const assetId of newOptionalAssetIds) {
            selectedOptionalAssetIds.add(assetId)
          }
          return [relationship]
        }
        return []
      }
      const withinPerVisualGuard =
        relationship.assetIds.length <= MAX_READABLE_FALLBACK_ASSETS_PER_VISUAL
      const assetsAvailable = relationship.assetIds.every((assetId) =>
        availableAssetIds.has(assetId),
      )
      if (relationship.kind === 'equation') {
        if (!withinPerVisualGuard || !assetsAvailable) {
          throw new PdfImportError(
            'INCOMPLETE_RECONSTRUCTION',
            `Readable EPUB reconstruction cannot retain matched equation relationship ${relationship.id} with its complete validated asset set.`,
          )
        }
        for (const assetId of relationship.assetIds) {
          selectedAssetIds.add(assetId)
        }
        return [validated]
      }
      const newOptionalAssetIds = relationship.assetIds.filter(
        (assetId) => !selectedAssetIds.has(assetId),
      )
      const accepted =
        withinPerVisualGuard &&
        assetsAvailable &&
        selectedOptionalAssetIds.size + newOptionalAssetIds.length <=
          MAX_READABLE_FALLBACK_OPTIONAL_ASSETS_PER_BOOK
      if (accepted) {
        for (const assetId of relationship.assetIds) {
          selectedAssetIds.add(assetId)
        }
        for (const assetId of newOptionalAssetIds) {
          selectedOptionalAssetIds.add(assetId)
        }
      }
      return accepted ? [validated] : []
    },
  )
  const projectedAssets = reconstruction.assets.filter((asset) =>
    selectedAssetIds.has(asset.id),
  )
  const projectedAssetIds = new Set(projectedAssets.map((asset) => asset.id))
  const incompleteEquationProjection = matchedEquationRelationships.find(
    (sourceRelationship) => {
      const projectedRelationships = relationships.filter(
        (relationship) => relationship.id === sourceRelationship.id,
      )
      return (
        projectedRelationships.length !== 1 ||
        projectedRelationships[0].kind !== 'equation' ||
        projectedRelationships[0].status !== 'matched' ||
        projectedRelationships[0].assetIds.length !==
          sourceRelationship.assetIds.length ||
        projectedRelationships[0].assetIds.some(
          (assetId, index) =>
            assetId !== sourceRelationship.assetIds[index] ||
            !projectedAssetIds.has(assetId),
        )
      )
    },
  )
  if (incompleteEquationProjection) {
    throw new PdfImportError(
      'INCOMPLETE_RECONSTRUCTION',
      `Readable EPUB reconstruction lost matched equation relationship ${incompleteEquationProjection.id} or one of its validated assets during projection.`,
    )
  }
  const paper = projectRenderableNoteRelationships(reconstruction.paper)
  if (!hasReadableText(paper)) {
    throw new PdfImportError(
      'INCOMPLETE_RECONSTRUCTION',
      'A readable EPUB requires recovered text after unvalidated visuals are omitted.',
    )
  }
  return {
    ...reconstruction,
    paper,
    provenance: reconstruction.provenance,
    visualRelationships: relationships,
    assets: projectedAssets,
  }
}

export function projectReadableFallbackReconstruction(
  reconstruction: PdfReconstruction,
): PdfReconstruction {
  if (reconstruction.completeness.ocrRequiredPages.length === 0) {
    return projectReadableTextFallbackReconstruction(reconstruction)
  }
  const readableProjection = hasReadableText(reconstruction.paper)
    ? projectReadableTextFallbackReconstruction(reconstruction)
    : {
        ...reconstruction,
        paper: { ...reconstruction.paper, nodes: [] },
        visualRelationships: [],
        assets: [],
      }
  const sourcePreserved = sourcePreservedOcrFallback(
    reconstruction,
    readableProjection,
  )
  if (sourcePreserved) return sourcePreserved
  throw new PdfImportError(
    'INCOMPLETE_RECONSTRUCTION',
    'A readable EPUB requires a bounded complete-page source render for every page that still needs text recovery.',
  )
}
