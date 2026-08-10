import type {
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfPageRegion,
  PdfReconstruction,
  PdfVisualAsset,
  PdfVisualMatchCandidate,
  PdfVisualRelationship,
} from './import-types'
import {
  validAssetContent,
  validAssetShape,
} from './pdf-visual-validation'
import { sha256HexSync } from './sha256-sync'

/**
 * Visual-match adjudication identity is versioned separately from the sidecar
 * so a schema change invalidates saved candidate choices instead of silently
 * rebinding them to a different source object.
 */
export const VISUAL_MATCH_DECISION_SCHEMA_VERSION = '1.3.0' as const

export const VISUAL_MATCH_ADJUDICATION_EVIDENCE = [
  'bounded-source-candidate',
  'complete-exportable-asset',
  'owner-local-adjudication',
] as const

export const VISUAL_MATCH_DIAGNOSTIC_CODES = [
  'AMBIGUOUS_VISUAL_MATCH',
  'UNRESOLVED_VISUAL_OBJECT',
] as const

export type VisualMatchDiagnosticCode =
  (typeof VISUAL_MATCH_DIAGNOSTIC_CODES)[number]

export type VisualMatchContext = {
  paper: PdfReconstruction['paper']
  regions: readonly PdfPageRegion[]
  visualRelationships: readonly PdfVisualRelationship[]
  assets: readonly PdfVisualAsset[]
  provenance: Readonly<Record<string, NodeSourceEvidence>>
}

export type VisualMatchCandidateBinding = {
  candidateId: string
  relationshipId: string
  relationshipFingerprintSha256: string
  origin: 'emitted-candidate' | 'bounded-source-fallback'
  sourceRegionIds: string[]
  sourceObjectIds: string[]
  assetIds: string[]
  assetSha256: string[]
  score: number
  evidence: string[]
  sourceBoxes: NormalizedSourceBox[]
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
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
  const normalized = (value: number) => (Object.is(value, -0) ? 0 : value)
  const numbers = [box.page, box.x, box.y, box.width, box.height, box.rotation]
  if (numbers.some((value) => !Number.isFinite(value))) return null
  return {
    page: normalized(box.page),
    x: normalized(box.x),
    y: normalized(box.y),
    width: normalized(box.width),
    height: normalized(box.height),
    rotation: normalized(box.rotation),
    method: box.method,
  }
}

function canonicalSourceBoxes(boxes: readonly NormalizedSourceBox[]) {
  const normalized = boxes.map(canonicalSourceBox)
  return normalized.every((box) => box !== null) ? normalized : null
}

function sameValues(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function unique(values: readonly string[]) {
  return new Set(values).size === values.length
}

/**
 * A candidate identity is derived only from the relationship it repairs, the
 * exact source region/object ids it names, the asset ids it exports, and the
 * decision-schema version. Position in `candidates` — or in any UI list — is
 * deliberately excluded so reordering cannot rebind a saved decision.
 */
export function visualMatchCandidateId(
  relationshipId: string,
  candidate: Pick<
    PdfVisualMatchCandidate,
    'sourceRegionIds' | 'sourceObjectIds' | 'assetIds'
  >,
) {
  const digest = sha256HexSync(
    canonicalJson({
      schemaVersion: VISUAL_MATCH_DECISION_SCHEMA_VERSION,
      relationshipId,
      sourceRegionIds: [...candidate.sourceRegionIds].sort(),
      sourceObjectIds: [...candidate.sourceObjectIds].sort(),
      assetIds: [...candidate.assetIds].sort(),
    }),
  )
  return `visual-candidate-${digest.slice(0, 24)}`
}

function relationshipMatches(
  context: VisualMatchContext,
  relationshipId: string,
) {
  const matches = context.visualRelationships.filter(
    (candidate) => candidate.id === relationshipId,
  )
  return matches.length === 1 ? matches[0] : null
}

function assetById(context: VisualMatchContext, assetId: string) {
  const matches = context.assets.filter(
    (candidate) => candidate.id === assetId,
  )
  return matches.length === 1 ? matches[0] : null
}

/**
 * The caption node a relationship must attach to. Exactly one canonical
 * caption node may own the caption region, otherwise the repair is ambiguous
 * and is refused.
 */
export function visualCaptionBinding(
  context: VisualMatchContext,
  relationship: PdfVisualRelationship,
) {
  const captionRegions = context.regions.filter(
    (region) => region.id === relationship.captionRegionId,
  )
  if (captionRegions.length !== 1) return null
  const captionRegion = captionRegions[0]
  const captionNodes = context.paper.nodes.filter(
    (node) =>
      node.type === 'caption' &&
      sameValues(context.provenance[node.id]?.regionIds ?? [], [
        captionRegion.id,
      ]),
  )
  if (captionNodes.length !== 1) return null
  const evidence = context.provenance[captionNodes[0].id]
  if (!evidence || evidence.boxes.length === 0) return null
  return { captionRegion, captionNodeId: captionNodes[0].id, evidence }
}

/**
 * A candidate is only offered when its complete exportable asset payload
 * already exists locally: every named asset resolves once, carries valid
 * bytes and a valid shape for the relationship kind, and its source lineage
 * reproduces the candidate's source objects exactly and in order.
 */
function completeCandidateAssets(
  context: VisualMatchContext,
  relationship: PdfVisualRelationship,
  candidate: Pick<
    PdfVisualMatchCandidate,
    'sourceObjectIds' | 'assetIds' | 'sourceRegionIds'
  >,
) {
  if (
    candidate.sourceObjectIds.length === 0 ||
    candidate.assetIds.length === 0 ||
    !unique(candidate.sourceObjectIds) ||
    !unique(candidate.assetIds) ||
    !unique(candidate.sourceRegionIds)
  ) {
    return null
  }
  const assets = candidate.assetIds.map((assetId) =>
    assetById(context, assetId),
  )
  if (assets.some((asset) => asset === null)) return null
  const resolved = assets as PdfVisualAsset[]
  const lineageObjectIds = resolved.flatMap((asset) => asset.sourceObjectIds)
  const lineageBoxes = resolved.flatMap((asset) => asset.sourceBoxes)
  if (
    !sameValues(lineageObjectIds, candidate.sourceObjectIds) ||
    lineageBoxes.length === 0 ||
    canonicalSourceBoxes(lineageBoxes) === null ||
    resolved.some(
      (asset) =>
        !validAssetContent(asset) ||
        !validAssetShape(asset, relationship.kind),
    )
  ) {
    return null
  }
  return resolved
}

function relationshipFingerprint(
  relationship: PdfVisualRelationship,
  caption: NonNullable<ReturnType<typeof visualCaptionBinding>>,
) {
  const sourceBoxes = canonicalSourceBoxes(relationship.sourceBoxes)
  const captionBox = canonicalSourceBox(caption.captionRegion.box)
  const candidates = relationship.candidates.map((candidate) => ({
    sourceRegionIds: [...candidate.sourceRegionIds],
    sourceObjectIds: [...candidate.sourceObjectIds],
    assetIds: [...candidate.assetIds],
    score: candidate.score,
    evidence: [...candidate.evidence],
    sourceBoxes: canonicalSourceBoxes(candidate.sourceBoxes),
  }))
  if (
    !sourceBoxes ||
    !captionBox ||
    candidates.some((candidate) => candidate.sourceBoxes === null)
  ) {
    return null
  }
  return sha256HexSync(
    canonicalJson({
      schemaVersion: 'visual-match-binding-v1',
      decisionSchemaVersion: VISUAL_MATCH_DECISION_SCHEMA_VERSION,
      relationship: {
        id: relationship.id,
        kind: relationship.kind,
        labelSha256: sha256HexSync(relationship.label),
        captionRegionId: relationship.captionRegionId,
        status: relationship.status,
        sourceRegionIds: [...relationship.sourceRegionIds],
        sourceObjectIds: [...relationship.sourceObjectIds],
        assetIds: [...relationship.assetIds],
        sourceBoxes,
        candidates,
      },
      caption: {
        nodeId: caption.captionNodeId,
        regionId: caption.captionRegion.id,
        kind: caption.captionRegion.kind,
        column: caption.captionRegion.column,
        box: captionBox,
        textSha256: sha256HexSync(caption.captionRegion.text),
      },
    }),
  )
}

/**
 * Bounded source-backed fallbacks: complete assets that already exist in the
 * reconstruction, sit on the caption's page, and are not claimed by any
 * matched relationship. They give an unresolved caption a legal repair when
 * the matcher emitted no scored candidate at all.
 */
function boundedSourceFallbackCandidates(
  context: VisualMatchContext,
  relationship: PdfVisualRelationship,
  captionPage: number,
): PdfVisualMatchCandidate[] {
  const claimed = new Set(
    context.visualRelationships
      .filter((candidate) => candidate.status === 'matched')
      .flatMap((candidate) => [
        ...candidate.assetIds,
        ...candidate.sourceObjectIds,
      ]),
  )
  return context.assets
    .filter(
      (asset) =>
        !claimed.has(asset.id) &&
        asset.sourceObjectIds.length > 0 &&
        asset.sourceObjectIds.every(
          (sourceObjectId) => !claimed.has(sourceObjectId),
        ) &&
        asset.sourceBoxes.length > 0 &&
        asset.sourceBoxes.every((box) => box.page === captionPage),
    )
    .map((asset) => ({
      sourceRegionIds: [...relationship.sourceRegionIds],
      sourceObjectIds: [...asset.sourceObjectIds],
      assetIds: [asset.id],
      score: 0,
      evidence: ['bounded-source-fallback', 'complete-exportable-asset'],
      sourceBoxes: asset.sourceBoxes.map((box) => ({ ...box })),
    }))
    .sort((left, right) => left.assetIds[0].localeCompare(right.assetIds[0]))
}

/**
 * Every legal `accept-visual-match` choice for one diagnostic. Only emitted
 * candidates and bounded source-backed fallbacks with complete local assets
 * are returned; nothing here can widen a threshold or hide a diagnostic.
 */
export function visualMatchAdjudicationCandidates(
  context: VisualMatchContext,
  relationshipId: string,
): VisualMatchCandidateBinding[] {
  const relationship = relationshipMatches(context, relationshipId)
  if (
    !relationship ||
    relationship.kind !== 'figure' ||
    relationship.status === 'matched' ||
    relationship.visualMatchAdjudication
  ) {
    return []
  }
  const caption = visualCaptionBinding(context, relationship)
  if (!caption) return []
  const relationshipFingerprintSha256 = relationshipFingerprint(
    relationship,
    caption,
  )
  if (!relationshipFingerprintSha256) return []
  const emitted = relationship.candidates.filter((candidate) =>
    completeCandidateAssets(context, relationship, candidate),
  )
  // Source-backed fallbacks are a strict fallback: they are only offered when
  // the matcher emitted no candidate with a complete payload, so one asset can
  // never appear twice under two identities.
  const offered =
    emitted.length > 0
      ? emitted.map(
          (candidate) => [candidate, 'emitted-candidate' as const] as const,
        )
      : boundedSourceFallbackCandidates(
          context,
          relationship,
          caption.captionRegion.box.page,
        ).map(
          (candidate) =>
            [candidate, 'bounded-source-fallback' as const] as const,
        )
  const bindings = new Map<string, VisualMatchCandidateBinding>()
  for (const [candidate, origin] of offered) {
    const assets = completeCandidateAssets(context, relationship, candidate)
    if (!assets) continue
    const candidateId = visualMatchCandidateId(relationship.id, candidate)
    if (bindings.has(candidateId)) continue
    bindings.set(candidateId, {
      candidateId,
      relationshipId: relationship.id,
      relationshipFingerprintSha256,
      origin,
      sourceRegionIds: [...candidate.sourceRegionIds],
      sourceObjectIds: [...candidate.sourceObjectIds],
      assetIds: [...candidate.assetIds],
      assetSha256: assets.map((asset) => asset.sha256),
      score: candidate.score,
      evidence: [...candidate.evidence],
      sourceBoxes: candidate.sourceBoxes.map((box) => ({ ...box })),
    })
  }
  return [...bindings.values()].sort((left, right) =>
    left.candidateId.localeCompare(right.candidateId),
  )
}

export function visualMatchAdjudicationCandidate(
  context: VisualMatchContext,
  relationshipId: string,
  candidateId: string,
) {
  return (
    visualMatchAdjudicationCandidates(context, relationshipId).find(
      (candidate) => candidate.candidateId === candidateId,
    ) ?? null
  )
}
