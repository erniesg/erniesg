import type {
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfNativeObject,
  PdfPageRegion,
  PdfVisualAsset,
  PdfVisualRelationship,
} from './import-types'
import type { ResearchPaper } from './schema'
import { isSourceVerifiedSemanticTable } from './semantic-table'
import { isValidSourcePageCropPayload } from './visual-assets'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ASSET_ID_PATTERN = /^asset-[a-f0-9]{24}$/
const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotateRight(value: number, bits: number) {
  return (value >>> bits) | (value << (32 - bits))
}

function sha256(bytes: Uint8Array) {
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  let bitLength = BigInt(bytes.length) * 8n
  for (let index = 0; index < 8; index += 1) {
    padded[padded.length - 1 - index] = Number(bitLength & 0xffn)
    bitLength >>= 8n
  }

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ])
  const words = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4
      words[index] =
        ((padded[start] << 24) |
          (padded[start + 1] << 16) |
          (padded[start + 2] << 8) |
          padded[start + 3]) >>>
        0
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15]
      const right = words[index - 2]
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3)
      const sigma1 =
        rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10)
      words[index] =
        (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0
    }

    let a = state[0]
    let b = state[1]
    let c = state[2]
    let d = state[3]
    let e = state[4]
    let f = state[5]
    let g = state[6]
    let h = state[7]
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temporary1 =
        (h + sigma1 + choice + SHA256_ROUND_CONSTANTS[index] + words[index]) >>>
        0
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temporary2 = (sigma0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temporary1) >>> 0
      d = c
      c = b
      b = a
      a = (temporary1 + temporary2) >>> 0
    }
    state[0] = (state[0] + a) >>> 0
    state[1] = (state[1] + b) >>> 0
    state[2] = (state[2] + c) >>> 0
    state[3] = (state[3] + d) >>> 0
    state[4] = (state[4] + e) >>> 0
    state[5] = (state[5] + f) >>> 0
    state[6] = (state[6] + g) >>> 0
    state[7] = (state[7] + h) >>> 0
  }
  return [...state].map((value) => value.toString(16).padStart(8, '0')).join('')
}

function sameStrings(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function boxKey(box: NormalizedSourceBox) {
  return [
    box.page,
    box.x,
    box.y,
    box.width,
    box.height,
    box.rotation,
    box.method,
  ].join(':')
}

function sameBoxes(left: NormalizedSourceBox[], right: NormalizedSourceBox[]) {
  return sameStrings(left.map(boxKey), right.map(boxKey))
}

function sameBoxMultiset(
  left: NormalizedSourceBox[],
  right: NormalizedSourceBox[],
) {
  return sameStrings(left.map(boxKey).sort(), right.map(boxKey).sort())
}

function subtractBoxes(
  source: NormalizedSourceBox[],
  removed: NormalizedSourceBox[],
) {
  const remaining = source.map((box) => ({ box, key: boxKey(box) }))
  for (const box of removed) {
    const index = remaining.findIndex(
      (candidate) => candidate.key === boxKey(box),
    )
    if (index < 0) return null
    remaining.splice(index, 1)
  }
  return remaining.map((candidate) => candidate.box)
}

function roundedSourceCoordinate(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function boundingSourceBox(boxes: NormalizedSourceBox[]) {
  const first = boxes[0]
  if (
    !first ||
    boxes.some(
      (box) =>
        box.page !== first.page ||
        box.rotation !== first.rotation ||
        box.method !== first.method,
    )
  ) {
    return null
  }
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return {
    page: first.page,
    x: roundedSourceCoordinate(left),
    y: roundedSourceCoordinate(top),
    width: roundedSourceCoordinate(right - left),
    height: roundedSourceCoordinate(bottom - top),
    rotation: first.rotation,
    method: first.method,
  }
}

function mediaExtensions(mediaType: PdfVisualAsset['mediaType']) {
  if (mediaType === 'image/png') return ['png']
  if (mediaType === 'image/jpeg') return ['jpg', 'jpeg']
  if (mediaType === 'image/gif') return ['gif']
  if (mediaType === 'image/svg+xml') return ['svg']
  return ['xhtml']
}

function validAssetContent(asset: PdfVisualAsset) {
  const contentSha256 = sha256(asset.bytes)
  const identitySha256 =
    asset.rendition === 'source-page-crop' && asset.sourceCropBox
      ? sha256(
          new TextEncoder().encode(
            `${contentSha256}\n${JSON.stringify({
              kind: asset.kind,
              cropBox: [
                asset.sourceCropBox.page,
                asset.sourceCropBox.x,
                asset.sourceCropBox.y,
                asset.sourceCropBox.width,
                asset.sourceCropBox.height,
                asset.sourceCropBox.rotation,
                asset.sourceCropBox.method,
              ],
              lineage: asset.sourceObjectIds.map((sourceObjectId, index) => {
                const box = asset.sourceBoxes[index]
                return [
                  sourceObjectId,
                  [
                    box.page,
                    box.x,
                    box.y,
                    box.width,
                    box.height,
                    box.rotation,
                    box.method,
                  ],
                ]
              }),
            })}`,
          ),
        )
      : contentSha256
  return (
    ASSET_ID_PATTERN.test(asset.id) &&
    asset.id === `asset-${identitySha256.slice(0, 24)}` &&
    mediaExtensions(asset.mediaType).some(
      (extension) => asset.href === `assets/${asset.id}.${extension}`,
    ) &&
    SHA256_PATTERN.test(asset.sha256) &&
    asset.bytes.byteLength > 0 &&
    contentSha256 === asset.sha256 &&
    Number.isFinite(asset.width) &&
    asset.width > 0 &&
    Number.isFinite(asset.height) &&
    asset.height > 0 &&
    asset.sourceObjectIds.length > 0 &&
    new Set(asset.sourceObjectIds).size === asset.sourceObjectIds.length &&
    asset.sourceBoxes.length === asset.sourceObjectIds.length
  )
}

function validAssetShape(
  asset: PdfVisualAsset,
  relationshipKind: PdfVisualRelationship['kind'],
) {
  if (asset.rendition === 'source-preserved') {
    return (
      (asset.kind === 'raster' &&
        ['image/png', 'image/jpeg', 'image/gif'].includes(asset.mediaType)) ||
      (asset.kind === 'vector' && asset.mediaType === 'image/svg+xml')
    )
  }
  if (asset.rendition === 'browser-composite-raster') {
    return (
      relationshipKind === 'figure' &&
      asset.kind === 'raster' &&
      asset.mediaType === 'image/png'
    )
  }
  if (asset.rendition === 'source-page-crop') {
    return (
      asset.kind ===
        (relationshipKind === 'figure' ? 'raster' : relationshipKind) &&
      asset.mediaType === 'image/png' &&
      Boolean(asset.sourceCropBox) &&
      asset.sourceCropBox!.page > 0 &&
      asset.sourceCropBox!.width > 0 &&
      asset.sourceCropBox!.height > 0
    )
  }
  return (
    asset.rendition === 'semantic-table' &&
    relationshipKind === 'table' &&
    asset.kind === 'table' &&
    asset.mediaType === 'application/xhtml+xml'
  )
}

function normalizedSourceText(value: string | undefined) {
  return value?.replace(/\s+/gu, ' ').trim() ?? ''
}

function sourceCropContainsBox(
  crop: NormalizedSourceBox,
  source: NormalizedSourceBox,
) {
  const tolerance = 0.00001
  return (
    crop.page === source.page &&
    crop.rotation === source.rotation &&
    crop.x <= source.x + tolerance &&
    crop.y <= source.y + tolerance &&
    crop.x + crop.width + tolerance >= source.x + source.width &&
    crop.y + crop.height + tolerance >= source.y + source.height
  )
}

function sourceBoxesOverlap(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  if (left.page !== right.page || left.rotation !== right.rotation) return false
  const tolerance = 0.00001
  const horizontal =
    Math.min(left.x + left.width, right.x + right.width) -
    Math.max(left.x, right.x)
  const vertical =
    Math.min(left.y + left.height, right.y + right.height) -
    Math.max(left.y, right.y)
  return horizontal > tolerance && vertical > tolerance
}

function validSharedEquationLineScope({
  relationship,
  regions,
  canonicalEvidence,
  competingOwnerIds,
  provenance,
}: {
  relationship: PdfVisualRelationship
  regions: readonly PdfPageRegion[] | undefined
  canonicalEvidence: NodeSourceEvidence
  competingOwnerIds: ReadonlySet<string>
  provenance: Record<string, NodeSourceEvidence>
}) {
  if (
    relationship.kind !== 'equation' ||
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
  const lineOccurrences = new Map<
    string,
    Array<{ regionId: string; line: PdfPageRegion['lines'][number] }>
  >()
  for (const region of regions) {
    const matchingRegions = regionOccurrences.get(region.id) ?? []
    matchingRegions.push(region)
    regionOccurrences.set(region.id, matchingRegions)
    for (const line of region.lines) {
      const matchingLines = lineOccurrences.get(line.id) ?? []
      matchingLines.push({ regionId: region.id, line })
      lineOccurrences.set(line.id, matchingLines)
    }
  }

  const sourceRegionIds = new Set(relationship.sourceRegionIds)
  if (
    relationship.sourceRegionIds.some(
      (regionId) => regionOccurrences.get(regionId)?.length !== 1,
    )
  ) {
    return false
  }
  const selectedLines = relationship.sourceLineIds.flatMap(
    (lineId) => lineOccurrences.get(lineId) ?? [],
  )
  if (
    selectedLines.length !== relationship.sourceLineIds.length ||
    relationship.sourceLineIds.some(
      (lineId) => lineOccurrences.get(lineId)?.length !== 1,
    ) ||
    selectedLines.some(({ regionId }) => !sourceRegionIds.has(regionId)) ||
    relationship.sourceRegionIds.some(
      (regionId) =>
        !selectedLines.some((selected) => selected.regionId === regionId),
    ) ||
    selectedLines.some(({ line }) =>
      canonicalEvidence.boxes.every(
        (sourceBox) => !sourceCropContainsBox(sourceBox, line.box),
      ),
    )
  ) {
    return false
  }

  for (const ownerId of competingOwnerIds) {
    const ownerEvidence = provenance[ownerId]
    if (!ownerEvidence || ownerEvidence.boxes.length === 0) return false
    if (
      selectedLines.some(({ line }) =>
        ownerEvidence.boxes.some((box) => sourceBoxesOverlap(box, line.box)),
      )
    ) {
      return false
    }
  }
  return true
}

function hasIncompleteInlineStackedEquationScope(
  relationship: PdfVisualRelationship,
  regions: readonly PdfPageRegion[] | undefined,
) {
  if (
    relationship.kind !== 'equation' ||
    !regions ||
    !relationship.sourceLineIds?.length
  ) {
    return false
  }
  const sourceLineIds = new Set(relationship.sourceLineIds)
  const inlineFormulaBaseIds = new Set(
    relationship.sourceLineIds.flatMap((lineId) => {
      const match = /^(.*-inline-stacked-\d+)-formula$/u.exec(lineId)
      return match ? [match[1]] : []
    }),
  )
  const selectedLines = regions.flatMap((region) =>
    region.lines.filter((line) => sourceLineIds.has(line.id)),
  )
  const hasStackedSourceGeometry = selectedLines.some((line) => {
    const runs = line.runs.filter((run) => run.text.trim())
    if (runs.length < 2) return false
    const maximumFontSize = Math.max(...runs.map((run) => run.fontSize))
    const stackedRuns = runs.filter(
      (run) => run.fontSize <= maximumFontSize * 0.86,
    )
    return stackedRuns.some((left, leftIndex) =>
      stackedRuns.slice(leftIndex + 1).some((right) => {
        const horizontalOverlap = Math.max(
          0,
          Math.min(left.x + left.width, right.x + right.width) -
            Math.max(left.x, right.x),
        )
        const minimumWidth = Math.min(left.width, right.width)
        const minimumHeight = Math.min(left.height, right.height)
        const verticalGap = Math.max(
          left.y - (right.y + right.height),
          right.y - (left.y + left.height),
          0,
        )
        return (
          minimumWidth > 0 &&
          minimumHeight > 0 &&
          horizontalOverlap >= minimumWidth * 0.7 &&
          Math.abs(
            left.x + left.width / 2 - (right.x + right.width / 2),
          ) <= Math.max(0.008, Math.max(left.width, right.width) * 0.3) &&
          Math.abs(
            left.y + left.height / 2 - (right.y + right.height / 2),
          ) >= Math.max(0.003, minimumHeight * 0.45) &&
          verticalGap <= Math.max(0.006, minimumHeight * 0.7)
        )
      }),
    )
  })
  const siblingRegions = regions.filter((region) =>
    region.lines.some((line) => {
      if (sourceLineIds.has(line.id)) return false
      const match = /^(.*-inline-stacked-\d+)-(before|after)$/u.exec(line.id)
      return Boolean(match && inlineFormulaBaseIds.has(match[1]))
    }),
  )
  return (
    inlineFormulaBaseIds.size > 0 &&
    siblingRegions.length > 0 &&
    (!hasStackedSourceGeometry ||
      siblingRegions.some((region) => region.kind !== 'body'))
  )
}

function validTableRendition({
  canonicalNode,
  relationship,
  renderedAssets,
  hasExplicitLineScope,
  regions,
  canonicalEvidence,
}: {
  canonicalNode: Extract<ResearchPaper['nodes'][number], { type: 'figure' }>
  relationship: PdfVisualRelationship
  renderedAssets: PdfVisualAsset[]
  hasExplicitLineScope: boolean
  regions: readonly PdfPageRegion[] | undefined
  canonicalEvidence: NodeSourceEvidence
}) {
  if (renderedAssets.length !== 1) return false
  const asset = renderedAssets[0]
  if (asset.rendition === 'semantic-table') {
    return (
      normalizedSourceText(canonicalNode.sourceText) ===
        normalizedSourceText(relationship.sourceText) &&
      isSourceVerifiedSemanticTable({
        table: canonicalNode.table,
        relationship,
        regions,
        evidence: canonicalEvidence,
      })
    )
  }
  if (
    asset.rendition !== 'source-page-crop' ||
    canonicalNode.table !== undefined ||
    !hasExplicitLineScope ||
    !relationship.evidence.includes('source-page-crop') ||
    !relationship.evidence.some((item) =>
      [
        'bounded-table-scope',
        'complete-bounded-table-scope',
        'detected-table-geometry',
      ].includes(item),
    ) ||
    normalizedSourceText(relationship.sourceText).length === 0 ||
    normalizedSourceText(canonicalNode.sourceText) !==
      normalizedSourceText(relationship.sourceText) ||
    !asset.sourceCropBox ||
    !isValidSourcePageCropPayload(asset) ||
    asset.sourceBoxes.some(
      (sourceBox) => !sourceCropContainsBox(asset.sourceCropBox!, sourceBox),
    )
  ) {
    return false
  }
  return true
}

function uniqueAssetsById(assets: PdfVisualAsset[]) {
  const counts = new Map<string, number>()
  for (const asset of assets)
    counts.set(asset.id, (counts.get(asset.id) ?? 0) + 1)
  return new Map(
    assets
      .filter((asset) => counts.get(asset.id) === 1)
      .map((asset) => [asset.id, asset]),
  )
}

export function validatedPdfVisualRelationships({
  paper,
  provenance,
  relationships,
  assets,
  regions,
}: {
  paper: ResearchPaper
  provenance?: Record<string, NodeSourceEvidence>
  relationships?: PdfVisualRelationship[]
  assets?: PdfVisualAsset[]
  regions?: readonly PdfPageRegion[]
}) {
  if (!provenance) return []
  const assetsById = uniqueAssetsById(assets ?? [])
  const relationshipCounts = new Map<string, number>()
  for (const relationship of relationships ?? []) {
    relationshipCounts.set(
      relationship.id,
      (relationshipCounts.get(relationship.id) ?? 0) + 1,
    )
  }
  const nodesById = new Map(paper.nodes.map((node) => [node.id, node]))
  const sourceRegionOwners = new Map<string, Set<string>>()
  for (const node of paper.nodes) {
    for (const regionId of provenance[node.id]?.regionIds ?? []) {
      const owners = sourceRegionOwners.get(regionId) ?? new Set<string>()
      owners.add(node.id)
      sourceRegionOwners.set(regionId, owners)
    }
  }
  return (relationships ?? []).filter((relationship) => {
    const hasExplicitTableLineScope = Boolean(
      relationship.kind === 'table' &&
      relationship.sourceLineIds?.length &&
      relationship.sourceLineIds.every((lineId) => lineId.length > 0) &&
      new Set(relationship.sourceLineIds).size ===
        relationship.sourceLineIds.length,
    )
    if (
      relationshipCounts.get(relationship.id) !== 1 ||
      relationship.status !== 'matched' ||
      relationship.canonicalNodeId === null ||
      relationship.captionNodeId === null ||
      relationship.sourceObjectIds.length === 0 ||
      (relationship.kind !== 'figure' &&
        relationship.sourceRegionIds.length === 0) ||
      relationship.assetIds.length === 0 ||
      relationship.sourceBoxes.length === 0 ||
      hasIncompleteInlineStackedEquationScope(relationship, regions) ||
      new Set(relationship.sourceObjectIds).size !==
        relationship.sourceObjectIds.length ||
      new Set(relationship.assetIds).size !== relationship.assetIds.length
    ) {
      return false
    }
    const permittedRegionOwners = new Set([
      relationship.canonicalNodeId,
      relationship.captionNodeId,
    ])
    const competingOwnerIds = new Set(
      relationship.sourceRegionIds.flatMap((regionId) =>
        [...(sourceRegionOwners.get(regionId) ?? [])].filter(
          (owner) => !permittedRegionOwners.has(owner),
        ),
      ),
    )
    const canonicalNode = nodesById.get(relationship.canonicalNodeId)
    const captionNode = nodesById.get(relationship.captionNodeId)
    const canonicalEvidence = provenance[relationship.canonicalNodeId]
    const captionEvidence = provenance[relationship.captionNodeId]
    if (
      canonicalNode?.type !== 'figure' ||
      (canonicalNode.objectType ?? 'figure') !== relationship.kind ||
      !sameStrings(
        canonicalNode.relationships.assets ?? [],
        relationship.assetIds,
      ) ||
      canonicalNode.relationships.caption !== relationship.captionNodeId ||
      captionNode?.type !== 'caption' ||
      relationship.captionRegionId.length === 0 ||
      !canonicalEvidence ||
      !captionEvidence ||
      !sameStrings(canonicalEvidence.regionIds, relationship.sourceRegionIds) ||
      !sameBoxes(canonicalEvidence.boxes, relationship.sourceBoxes) ||
      !sameStrings(
        canonicalEvidence.pages.map(String),
        [...new Set(relationship.sourceBoxes.map((box) => box.page))].map(
          String,
        ),
      ) ||
      !sameStrings(captionEvidence.regionIds, [relationship.captionRegionId]) ||
      captionEvidence.boxes.length === 0 ||
      !sameStrings(
        captionEvidence.pages.map(String),
        [...new Set(captionEvidence.boxes.map((box) => box.page))].map(String),
      )
    ) {
      return false
    }
    if (
      competingOwnerIds.size > 0 &&
      !hasExplicitTableLineScope &&
      !validSharedEquationLineScope({
        relationship,
        regions,
        canonicalEvidence,
        competingOwnerIds,
        provenance,
      })
    ) {
      return false
    }
    const captionSourceBox =
      hasExplicitTableLineScope && relationship.kind === 'table'
        ? (relationship.sourceBoxes[0] ?? null)
        : boundingSourceBox(captionEvidence.boxes)
    if (!captionSourceBox) return false
    const visualSourceBoxes = subtractBoxes(relationship.sourceBoxes, [
      captionSourceBox,
    ])
    if (!visualSourceBoxes) return false
    const renderedAssets = relationship.assetIds
      .map((assetId) => assetsById.get(assetId))
      .filter((asset): asset is PdfVisualAsset => Boolean(asset))
    if (
      renderedAssets.length !== relationship.assetIds.length ||
      renderedAssets.some(
        (asset) =>
          !validAssetContent(asset) ||
          !validAssetShape(asset, relationship.kind),
      ) ||
      !sameStrings(
        renderedAssets.flatMap((asset) => asset.sourceObjectIds),
        relationship.sourceObjectIds,
      ) ||
      !sameBoxMultiset(
        renderedAssets.flatMap((asset) => asset.sourceBoxes),
        visualSourceBoxes,
      )
    ) {
      return false
    }
    if (
      relationship.kind === 'table' &&
      !validTableRendition({
        canonicalNode,
        relationship,
        renderedAssets,
        hasExplicitLineScope: hasExplicitTableLineScope,
        regions,
        canonicalEvidence,
      })
    ) {
      return false
    }
    return true
  })
}

export function hasValidatedNativeAsset(
  object: PdfNativeObject,
  assets: PdfVisualAsset[] | undefined,
) {
  if (!object.assetId) return false
  const asset = uniqueAssetsById(assets ?? []).get(object.assetId)
  return Boolean(
    asset &&
    validAssetContent(asset) &&
    asset.rendition === 'source-preserved' &&
    asset.kind === (object.kind === 'image' ? 'raster' : 'vector') &&
    sameStrings(asset.sourceObjectIds, [object.id]) &&
    sameBoxes(asset.sourceBoxes, [object.box]),
  )
}
