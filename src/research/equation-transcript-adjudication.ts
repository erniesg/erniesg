import type {
  NormalizedSourceBox,
  PdfReconstruction,
  PdfVisualRelationship,
} from './import-types'
import { sha256HexSync } from './sha256-sync'
import { isValidSourcePageCropPayload } from './visual-assets'

export const OWNER_EQUATION_TRANSCRIPT_EVIDENCE = [
  'owner-adjudicated-equation-transcript-v1',
  'equation-transcript-format-latex',
  'exact-source-page-crop',
  'owner-local-adjudication',
] as const

export type EquationTranscriptContext = {
  paper: PdfReconstruction['paper']
  pages: readonly PdfReconstruction['pages'][number][]
  regions: readonly PdfReconstruction['regions'][number][]
  visualRelationships: readonly PdfVisualRelationship[]
  assets: readonly PdfReconstruction['assets'][number][]
}

function sameValues(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function syntheticEquationSourcePage(sourceObjectId: string) {
  const match = /^equation-source-p([0-9]{3})-[0-9]{3}$/u.exec(sourceObjectId)
  if (!match) return null
  const page = Number(match[1])
  return Number.isSafeInteger(page) && page > 0 ? page : null
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function canonicalSourceBox(box: NormalizedSourceBox) {
  const normalizedNumber = (value: number) => (Object.is(value, -0) ? 0 : value)
  const numericValues = [
    box.page,
    box.x,
    box.y,
    box.width,
    box.height,
    box.rotation,
  ]
  if (numericValues.some((value) => !Number.isFinite(value))) return null
  return {
    page: normalizedNumber(box.page),
    x: normalizedNumber(box.x),
    y: normalizedNumber(box.y),
    width: normalizedNumber(box.width),
    height: normalizedNumber(box.height),
    rotation: normalizedNumber(box.rotation),
    method: box.method,
  }
}

function canonicalSourceBoxes(boxes: readonly NormalizedSourceBox[]) {
  const normalized = boxes.map(canonicalSourceBox)
  return normalized.every(
    (box): box is NonNullable<ReturnType<typeof canonicalSourceBox>> =>
      box !== null,
  )
    ? normalized
    : null
}

export type EquationTranscriptDecisionBinding = {
  relationshipId: string
  relationshipFingerprintSha256: string
  sourceCropAssetId: string
  sourceCropAssetSha256: string
}

export function equationTranscriptDecisionBinding(
  reconstruction: EquationTranscriptContext,
  relationshipId: string,
): EquationTranscriptDecisionBinding | null {
  const relationshipMatches = reconstruction.visualRelationships.filter(
    (candidate) => candidate.id === relationshipId,
  )
  if (relationshipMatches.length !== 1) return null
  const relationship = relationshipMatches[0]
  if (
    relationship.kind !== 'equation' ||
    relationship.status !== 'matched' ||
    relationship.confidence <= 0 ||
    relationship.sourceText.trim().length > 0 ||
    relationship.equationTranscriptAdjudication ||
    !relationship.evidence.includes('source-text-transcript-unresolved') ||
    !relationship.evidence.includes('source-page-crop') ||
    relationship.sourceRegionIds.length === 0 ||
    !relationship.sourceLineIds?.length ||
    relationship.sourceObjectIds.length === 0 ||
    relationship.sourceBoxes.length === 0 ||
    relationship.assetIds.length !== 1 ||
    new Set(relationship.sourceRegionIds).size !==
      relationship.sourceRegionIds.length ||
    new Set(relationship.sourceLineIds).size !==
      relationship.sourceLineIds.length ||
    new Set(relationship.sourceObjectIds).size !==
      relationship.sourceObjectIds.length
  ) {
    return null
  }

  const assetMatches = reconstruction.assets.filter(
    (candidate) => candidate.id === relationship.assetIds[0],
  )
  if (assetMatches.length !== 1) return null
  const cropAsset = assetMatches[0]
  const cropSourceBoxes = canonicalSourceBoxes(cropAsset.sourceBoxes)
  const cropBox = cropAsset.sourceCropBox
    ? canonicalSourceBox(cropAsset.sourceCropBox)
    : null
  const cropBoxIdentity = (box: NormalizedSourceBox) => [
    box.page,
    box.x,
    box.y,
    box.width,
    box.height,
    box.rotation,
    box.method,
  ]
  const cropIdentitySha256 = cropAsset.sourceCropBox
    ? sha256HexSync(
        `${cropAsset.sha256}\n${JSON.stringify({
          kind: cropAsset.kind,
          cropBox: cropBoxIdentity(cropAsset.sourceCropBox),
          lineage: cropAsset.sourceObjectIds.map((sourceObjectId, index) => [
            sourceObjectId,
            cropAsset.sourceBoxes[index]
              ? cropBoxIdentity(cropAsset.sourceBoxes[index])
              : null,
          ]),
        })}`,
      )
    : null
  if (
    cropAsset.rendition !== 'source-page-crop' ||
    cropAsset.kind !== 'equation' ||
    cropAsset.mediaType !== 'image/png' ||
    !isValidSourcePageCropPayload(cropAsset) ||
    !/^[a-f0-9]{64}$/u.test(cropAsset.sha256) ||
    sha256HexSync(cropAsset.bytes) !== cropAsset.sha256 ||
    !cropIdentitySha256 ||
    cropAsset.id !== `asset-${cropIdentitySha256.slice(0, 24)}` ||
    cropAsset.href !== `assets/${cropAsset.id}.png` ||
    !sameValues(cropAsset.sourceObjectIds, relationship.sourceObjectIds) ||
    !cropBox ||
    !cropSourceBoxes
  ) {
    return null
  }

  const regionLineages = relationship.sourceRegionIds.flatMap((regionId) => {
    const matches = reconstruction.regions.filter(
      (candidate) => candidate.id === regionId,
    )
    if (matches.length !== 1) return []
    const region = matches[0]
    const regionBox = canonicalSourceBox(region.box)
    const lineBoxes = canonicalSourceBoxes(region.lines.map((line) => line.box))
    if (!regionBox || !lineBoxes) return []
    const runBoxes = region.lines.map((line) => canonicalSourceBoxes(line.runs))
    if (runBoxes.some((boxes) => boxes === null)) return []
    return [
      {
        id: region.id,
        page: region.page,
        kind: region.kind,
        column: region.column,
        box: regionBox,
        nativeObjectIds: [...region.nativeObjectIds],
        lines: region.lines.map((line, index) => ({
          id: line.id,
          textSha256: sha256HexSync(line.text),
          box: lineBoxes[index],
          runBoxes: runBoxes[index],
        })),
      },
    ]
  })
  if (regionLineages.length !== relationship.sourceRegionIds.length) {
    return null
  }
  const exactRegionLineIds = regionLineages.flatMap((region) =>
    region.lines.map((line) => line.id),
  )
  if (!sameValues(exactRegionLineIds, relationship.sourceLineIds)) return null
  const exactRegionObjectIds = [
    ...new Set(regionLineages.flatMap((region) => region.nativeObjectIds)),
  ]
  const syntheticSourcePage =
    relationship.sourceObjectIds.length === 1
      ? syntheticEquationSourcePage(relationship.sourceObjectIds[0])
      : null
  const syntheticSourceLineage =
    exactRegionObjectIds.length === 0 &&
    syntheticSourcePage !== null &&
    regionLineages.every((region) => region.page === syntheticSourcePage)
  if (
    !sameValues(exactRegionObjectIds, relationship.sourceObjectIds) &&
    !syntheticSourceLineage
  ) {
    return null
  }

  type BoundSourceObject = {
    id: string
    page: number
    kind: string
    box: NonNullable<ReturnType<typeof canonicalSourceBox>>
    assetId: string | null
    role: string | null
    rolePolicy: string | null
  }
  const sourceObjects = relationship.sourceObjectIds.flatMap<BoundSourceObject>(
    (sourceObjectId, index) => {
      const matches = reconstruction.pages.flatMap((page) =>
        (page.objects ?? []).filter(
          (candidate) => candidate.id === sourceObjectId,
        ),
      )
      if (matches.length === 0 && syntheticSourceLineage) {
        const sourceBox = cropSourceBoxes[index]
        return sourceBox
          ? [
              {
                id: sourceObjectId,
                page: syntheticSourcePage,
                kind: 'synthetic-equation-source',
                box: sourceBox,
                assetId: cropAsset.id,
                role: null,
                rolePolicy: null,
              },
            ]
          : []
      }
      if (matches.length !== 1) return []
      const sourceObject = matches[0]
      const box = canonicalSourceBox(sourceObject.box)
      return box
        ? [
            {
              id: sourceObject.id,
              page: sourceObject.page,
              kind: sourceObject.kind,
              box,
              assetId: sourceObject.assetId,
              role: sourceObject.role ?? null,
              rolePolicy: sourceObject.rolePolicy ?? null,
            },
          ]
        : []
    },
  )
  if (sourceObjects.length !== relationship.sourceObjectIds.length) return null

  const canonicalNodeMatches = reconstruction.paper.nodes.filter(
    (node) => node.id === relationship.canonicalNodeId,
  )
  if (
    canonicalNodeMatches.length !== 1 ||
    canonicalNodeMatches[0].type !== 'figure' ||
    canonicalNodeMatches[0].objectType !== 'equation' ||
    canonicalNodeMatches[0].sourceText !== undefined
  ) {
    return null
  }
  const canonicalNode = canonicalNodeMatches[0]
  const relationshipSourceBoxes = canonicalSourceBoxes(relationship.sourceBoxes)
  if (!relationshipSourceBoxes) return null
  const relationshipFingerprintSha256 = sha256HexSync(
    canonicalJson({
      schemaVersion: 'equation-transcript-binding-v1',
      relationship: {
        id: relationship.id,
        kind: relationship.kind,
        semanticKind: relationship.semanticKind ?? null,
        labelSha256: sha256HexSync(relationship.label),
        captionRegionId: relationship.captionRegionId,
        sourceRegionIds: relationship.sourceRegionIds,
        sourceLineIds: relationship.sourceLineIds,
        sourceObjectIds: relationship.sourceObjectIds,
        assetIds: relationship.assetIds,
        status: relationship.status,
        confidence: relationship.confidence,
        evidence: relationship.evidence,
        candidates: relationship.candidates,
        sourceBoxes: relationshipSourceBoxes,
        sourceTextSha256: sha256HexSync(relationship.sourceText),
        altTextSha256: sha256HexSync(relationship.altText),
        altTextSource: relationship.altTextSource,
        canonicalNodeId: relationship.canonicalNodeId,
        captionNodeId: relationship.captionNodeId,
      },
      canonicalNodeSha256: sha256HexSync(canonicalJson(canonicalNode)),
      sourceRegions: regionLineages,
      sourceObjects,
      sourceCropAsset: {
        id: cropAsset.id,
        sha256: cropAsset.sha256,
        kind: cropAsset.kind,
        rendition: cropAsset.rendition,
        mediaType: cropAsset.mediaType,
        width: cropAsset.width,
        height: cropAsset.height,
        sourceObjectIds: cropAsset.sourceObjectIds,
        sourceBoxes: cropSourceBoxes,
        sourceCropBox: cropBox,
      },
    }),
  )
  return {
    relationshipId: relationship.id,
    relationshipFingerprintSha256,
    sourceCropAssetId: cropAsset.id,
    sourceCropAssetSha256: cropAsset.sha256,
  }
}

export function verifyEquationTranscriptAdjudication(
  reconstruction: EquationTranscriptContext,
  relationshipId: string,
) {
  const relationshipMatches = reconstruction.visualRelationships.filter(
    (candidate) => candidate.id === relationshipId,
  )
  if (relationshipMatches.length !== 1) return false
  const relationship = relationshipMatches[0]
  const adjudication = relationship.equationTranscriptAdjudication
  if (
    !adjudication ||
    adjudication.schemaVersion !== '1.0.0' ||
    adjudication.format !== 'latex' ||
    adjudication.source !== 'owner-local-adjudication' ||
    relationship.sourceText.trim().length === 0 ||
    sha256HexSync(relationship.sourceText) !== adjudication.transcriptSha256 ||
    OWNER_EQUATION_TRANSCRIPT_EVIDENCE.some(
      (evidence) =>
        relationship.evidence.filter((candidate) => candidate === evidence)
          .length !== 1,
    )
  ) {
    return false
  }
  const canonicalNodeMatches = reconstruction.paper.nodes.filter(
    (node) => node.id === relationship.canonicalNodeId,
  )
  if (
    canonicalNodeMatches.length !== 1 ||
    canonicalNodeMatches[0].type !== 'figure' ||
    canonicalNodeMatches[0].sourceText !== relationship.sourceText
  ) {
    return false
  }
  const canonicalNode = canonicalNodeMatches[0]
  const originalRelationship = {
    ...relationship,
    sourceText: '',
    evidence: relationship.evidence.filter(
      (evidence) =>
        !OWNER_EQUATION_TRANSCRIPT_EVIDENCE.includes(
          evidence as (typeof OWNER_EQUATION_TRANSCRIPT_EVIDENCE)[number],
        ),
    ),
    equationTranscriptAdjudication: undefined,
  } satisfies PdfVisualRelationship
  const originalCanonicalNode = { ...canonicalNode }
  delete originalCanonicalNode.sourceText
  const originalContext: EquationTranscriptContext = {
    ...reconstruction,
    paper: {
      ...reconstruction.paper,
      nodes: reconstruction.paper.nodes.map((node) =>
        node === canonicalNode ? originalCanonicalNode : node,
      ),
    },
    visualRelationships: reconstruction.visualRelationships.map((candidate) =>
      candidate === relationship ? originalRelationship : candidate,
    ),
  }
  const binding = equationTranscriptDecisionBinding(
    originalContext,
    relationship.id,
  )
  return Boolean(
    binding &&
    binding.relationshipFingerprintSha256 ===
      adjudication.relationshipFingerprintSha256 &&
    binding.sourceCropAssetId === adjudication.sourceCropAssetId &&
    binding.sourceCropAssetSha256 === adjudication.sourceCropAssetSha256,
  )
}
