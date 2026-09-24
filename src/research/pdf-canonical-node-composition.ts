import type { ResearchNode } from './schema'
import type {
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfLinkAnnotation,
  PdfNoteRelationship,
  PdfVisualAsset,
  PdfVisualRelationship,
} from './import-types'
import {
  sourceEvidence,
  type PdfInlineSourceBlock,
} from './pdf-source-inline-evidence'
import { visualCanonicalNodeId } from './pdf-visuals'

const CAPTION_ENVELOPE_TOLERANCE = 0.00002

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
    box.x + box.width <= 1 + CAPTION_ENVELOPE_TOLERANCE &&
    box.y + box.height <= 1 + CAPTION_ENVELOPE_TOLERANCE
  )
}

function boxGap(left: NormalizedSourceBox, right: NormalizedSourceBox) {
  return {
    horizontal: Math.max(
      left.x - (right.x + right.width),
      right.x - (left.x + left.width),
      0,
    ),
    vertical: Math.max(
      left.y - (right.y + right.height),
      right.y - (left.y + left.height),
      0,
    ),
  }
}

function connectedCaptionBoxes(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  const gap = boxGap(left, right)
  const verticalOverlap =
    Math.min(left.y + left.height, right.y + right.height) -
    Math.max(left.y, right.y)
  const horizontalOverlap =
    Math.min(left.x + left.width, right.x + right.width) -
    Math.max(left.x, right.x)
  return (
    (verticalOverlap > 0 &&
      gap.horizontal <= Math.max(0.04, left.height * 2, right.height * 2)) ||
    (horizontalOverlap > 0 &&
      gap.vertical <= Math.max(0.03, left.height * 1.5, right.height * 1.5))
  )
}

function oneConnectedCaptionComponent(boxes: NormalizedSourceBox[]) {
  const reached = new Set<number>([0])
  let changed = true
  while (changed) {
    changed = false
    for (let index = 0; index < boxes.length; index += 1) {
      if (reached.has(index)) continue
      if (
        [...reached].some((candidate) =>
          connectedCaptionBoxes(boxes[candidate], boxes[index]),
        )
      ) {
        reached.add(index)
        changed = true
      }
    }
  }
  return reached.size === boxes.length
}

export function sameSourceBox(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  return (
    left.page === right.page &&
    left.rotation === right.rotation &&
    left.method === right.method &&
    (['x', 'y', 'width', 'height'] as const).every(
      (key) => rounded(left[key]) === rounded(right[key]),
    )
  )
}

function visualLineageBoxes(
  relationship: PdfVisualRelationship,
  assetsById: ReadonlyMap<string, PdfVisualAsset>,
) {
  if (
    relationship.assetIds.length === 0 ||
    new Set(relationship.assetIds).size !== relationship.assetIds.length
  ) {
    return null
  }
  const assets = relationship.assetIds.map((assetId) => assetsById.get(assetId))
  if (assets.some((asset) => asset === undefined)) return null
  const matchedAssets = assets.filter(
    (asset): asset is PdfVisualAsset => asset !== undefined,
  )
  const sourceObjectIds = matchedAssets.flatMap(
    (asset) => asset.sourceObjectIds,
  )
  const sourceBoxes = matchedAssets.flatMap((asset) => asset.sourceBoxes)
  if (
    sourceBoxes.length === 0 ||
    sourceBoxes.some((box) => !validNormalizedSourceBox(box)) ||
    sourceObjectIds.length !== relationship.sourceObjectIds.length ||
    sourceObjectIds.some(
      (sourceObjectId, index) =>
        sourceObjectId !== relationship.sourceObjectIds[index],
    )
  ) {
    return null
  }
  return sourceBoxes.map((box) => ({ ...box }))
}

export function captionProvenanceEnvelope(
  evidence: NodeSourceEvidence | undefined,
  captionRegionId: string,
  placeholder: NormalizedSourceBox,
  options: { allowExactRegionOverflow?: boolean } = {},
) {
  const boxes = evidence?.boxes ?? []
  const first = boxes[0]
  if (
    !evidence ||
    evidence.regionIds.length !== 1 ||
    evidence.regionIds[0] !== captionRegionId ||
    evidence.pages.length !== 1 ||
    !validNormalizedSourceBox(placeholder) ||
    !first ||
    boxes.some(
      (box) =>
        !validNormalizedSourceBox(box) ||
        box.page !== first.page ||
        box.rotation !== first.rotation ||
        box.method !== first.method ||
        box.page !== placeholder.page ||
        box.rotation !== placeholder.rotation ||
        box.method !== placeholder.method ||
        (!options.allowExactRegionOverflow &&
          (box.x < placeholder.x - CAPTION_ENVELOPE_TOLERANCE ||
            box.y < placeholder.y - CAPTION_ENVELOPE_TOLERANCE ||
            box.x + box.width >
              placeholder.x + placeholder.width + CAPTION_ENVELOPE_TOLERANCE ||
            box.y + box.height >
              placeholder.y + placeholder.height + CAPTION_ENVELOPE_TOLERANCE)),
    ) ||
    evidence.pages[0] !== first.page ||
    !oneConnectedCaptionComponent(boxes)
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

export function placeMatchedCanonicalNotes(
  nodes: ResearchNode[],
  relationships: readonly PdfNoteRelationship[],
) {
  const sourcePositions = new Map(
    nodes.map((node, index) => [node.id, index] as const),
  )
  const matchedByTarget = new Map<
    string,
    Array<
      PdfNoteRelationship & {
        targetNoteId: string
        canonicalAnchor: NonNullable<PdfNoteRelationship['canonicalAnchor']>
      }
    >
  >()
  for (const relationship of relationships) {
    if (
      relationship.status !== 'matched' ||
      relationship.targetNoteId === null ||
      relationship.canonicalAnchor === null
    ) {
      continue
    }
    const matches = matchedByTarget.get(relationship.targetNoteId) ?? []
    matches.push(
      relationship as PdfNoteRelationship & {
        targetNoteId: string
        canonicalAnchor: NonNullable<PdfNoteRelationship['canonicalAnchor']>
      },
    )
    matchedByTarget.set(relationship.targetNoteId, matches)
  }

  const moved = new Set<string>()
  const ownerByNoteId = new Map<string, string>()
  const authorNotes: ResearchNode[] = []
  const notesAfterOwner = new Map<string, ResearchNode[]>()
  for (const [targetNoteId, targetRelationships] of matchedByTarget) {
    const note = nodes.find(
      (node) => node.id === targetNoteId && node.type === 'footnote',
    )
    if (!note) continue
    const anchorKinds = new Set(
      targetRelationships.map(
        (relationship) => relationship.canonicalAnchor.kind,
      ),
    )
    if (anchorKinds.size !== 1) continue
    if (anchorKinds.has('author')) {
      authorNotes.push(note)
      moved.add(note.id)
      continue
    }
    const ownerIds = [
      ...new Set(
        targetRelationships.flatMap((relationship) =>
          relationship.canonicalAnchor.kind === 'node'
            ? [relationship.canonicalAnchor.nodeId]
            : [],
        ),
      ),
    ]
    if (
      ownerIds.length === 0 ||
      ownerIds.some((ownerId) => !sourcePositions.has(ownerId))
    ) {
      continue
    }
    const ownerId = ownerIds.sort(
      (left, right) => sourcePositions.get(right)! - sourcePositions.get(left)!,
    )[0]
    const ownerNotes = notesAfterOwner.get(ownerId) ?? []
    ownerNotes.push(note)
    notesAfterOwner.set(ownerId, ownerNotes)
    ownerByNoteId.set(note.id, ownerId)
    moved.add(note.id)
  }

  const cyclicNoteIds = new Set<string>()
  for (const noteId of ownerByNoteId.keys()) {
    const path: string[] = []
    const pathIndexById = new Map<string, number>()
    let currentId: string | undefined = noteId
    while (currentId && ownerByNoteId.has(currentId)) {
      const cycleStart = pathIndexById.get(currentId)
      if (cycleStart !== undefined) {
        for (const cyclicNoteId of path.slice(cycleStart)) {
          cyclicNoteIds.add(cyclicNoteId)
        }
        break
      }
      pathIndexById.set(currentId, path.length)
      path.push(currentId)
      currentId = ownerByNoteId.get(currentId)
    }
  }
  if (cyclicNoteIds.size > 0) {
    for (const noteId of cyclicNoteIds) moved.delete(noteId)
    for (const [ownerId, ownerNotes] of notesAfterOwner) {
      notesAfterOwner.set(
        ownerId,
        ownerNotes.filter((note) => !cyclicNoteIds.has(note.id)),
      )
    }
  }

  const sourceOrder = (left: ResearchNode, right: ResearchNode) =>
    sourcePositions.get(left.id)! - sourcePositions.get(right.id)!
  authorNotes.sort(sourceOrder)
  for (const ownerNotes of notesAfterOwner.values()) {
    ownerNotes.sort(sourceOrder)
  }
  const expanded = new Set<string>()
  const expandNoteTree = (node: ResearchNode): ResearchNode[] => {
    if (expanded.has(node.id)) return []
    expanded.add(node.id)
    return [
      node,
      ...(notesAfterOwner.get(node.id) ?? []).flatMap(expandNoteTree),
    ]
  }
  const placed = nodes
    .filter((node) => !moved.has(node.id))
    .flatMap(expandNoteTree)
  nodes.splice(
    0,
    nodes.length,
    ...authorNotes.flatMap(expandNoteTree),
    ...placed,
  )
}

export type CanonicalVisualDraft = {
  captionBlock: PdfInlineSourceBlock & { nodeId: string }
  captionEnvelope: NormalizedSourceBox
  lineageBoxes: NormalizedSourceBox[]
  page: number
  id: string
  source: string
}

export function canonicalVisualDraft(
  relationship: PdfVisualRelationship,
  blocks: PdfInlineSourceBlock[],
  assetsById: ReadonlyMap<string, PdfVisualAsset>,
  embeddedLinks: PdfLinkAnnotation[],
  sourceHash: string,
): CanonicalVisualDraft | null {
  relationship.canonicalNodeId = null
  const captionBlock = blocks.find(
    (block): block is PdfInlineSourceBlock & { nodeId: string } =>
      block.region.id === relationship.captionRegionId && Boolean(block.nodeId),
  )
  relationship.captionNodeId = captionBlock?.nodeId ?? null
  // Table and equation relationships carry their bounded content scope in
  // sourceBoxes. The caption is identified separately, so never infer it from
  // the first content box: doing so loses a valid caption-below table node.
  const captionPlaceholder = captionBlock?.region.box
  const lineageBoxes = visualLineageBoxes(relationship, assetsById)
  const verifiedCaptionEnvelope =
    captionBlock && captionPlaceholder
      ? captionProvenanceEnvelope(
          sourceEvidence(captionBlock, embeddedLinks),
          relationship.captionRegionId,
          captionPlaceholder,
          {
            allowExactRegionOverflow:
              relationship.kind === 'equation' &&
              relationship.altTextSource === 'source-text' &&
              relationship.sourceRegionIds.includes(
                relationship.captionRegionId,
              ),
          },
        )
      : null
  // A caption can contain source-backed runs whose PDF coordinates extend
  // beyond its classified region (for example, an adjacent export stamp). The
  // caption node is already canonical and source-identified; retain its
  // bounded region as the relationship anchor instead of discarding a fully
  // validated table crop and all of its table-cell provenance.
  const captionEnvelope =
    verifiedCaptionEnvelope ??
    (captionBlock && validNormalizedSourceBox(captionBlock.region.box)
      ? { ...captionBlock.region.box }
      : null)
  const sourcePreservedFallback =
    relationship.status !== 'matched' &&
    relationship.assetIds.length > 0 &&
    relationship.evidence.includes('source-preserved-table-fallback')
  if (
    (!sourcePreservedFallback && relationship.status !== 'matched') ||
    !captionBlock ||
    !captionPlaceholder ||
    !sameSourceBox(captionPlaceholder, captionBlock.region.box) ||
    !captionEnvelope ||
    !lineageBoxes
  ) {
    return null
  }
  const page = captionEnvelope.page
  const id = visualCanonicalNodeId(relationship, page)
  relationship.canonicalNodeId = id
  return {
    captionBlock,
    captionEnvelope,
    lineageBoxes,
    page,
    id,
    source: `pdf:${sourceHash.slice(0, 16)}#page=${page}`,
  }
}
