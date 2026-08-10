import { createHash } from 'node:crypto'
import { serializePublicationGraph, type PublicationGraph, type PublicationNode } from './schema'
import { serializeAssetBundle } from './asset-bundle'
import type { PublicationSourceResult } from './source-adapter'

export const PUBLICATION_CONFORMANCE_VERSION = '1.0.0' as const

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Remove adapter/source identity while retaining the meaning graph.  Node
 * identifiers are normalized by source order so equivalent Astro and Payload
 * fixtures can use different source ids without weakening relationship checks.
 */
export function canonicalPublicationSubset(
  value: PublicationGraph | PublicationSourceResult,
) {
  const graph = 'graph' in value ? value.graph : value
  const parsed = graph
  const idMap = new Map(parsed.nodes.map((node, index) => [node.id, `node-${index + 1}`]))
  const normalizeTarget = (target: string) => idMap.get(target) ?? target
  const normalizeNode = (node: PublicationNode) => {
    const { provenance: _provenance, edition: nodeEdition, id: _id, ...rest } = node
    const edition = {
      editionId: 'edition',
      ...(nodeEdition.equivalentNodeId
        ? { equivalentNodeId: normalizeTarget(nodeEdition.equivalentNodeId) }
        : {}),
    }
    const normalized: Record<string, unknown> = {
      ...rest,
      edition,
      id: idMap.get(node.id) ?? node.id,
    }
    if ('itemIds' in node) normalized.itemIds = node.itemIds.map(normalizeTarget)
    if ('parentListId' in node) normalized.parentListId = normalizeTarget(node.parentListId)
    if ('childListIds' in node) normalized.childListIds = node.childListIds.map(normalizeTarget)
    if ('captionId' in node && node.captionId) normalized.captionId = normalizeTarget(node.captionId)
    if ('parentId' in node) normalized.parentId = normalizeTarget(node.parentId)
    if ('backlinkIds' in node) normalized.backlinkIds = node.backlinkIds.map(normalizeTarget)
    if ('targetIds' in node) normalized.targetIds = node.targetIds.map(normalizeTarget)
    if ('inlineRuns' in node && node.inlineRuns) {
      normalized.inlineRuns = node.inlineRuns.map((run) => ({
        ...run,
        ...(run.annotationId ? { annotationId: normalizeTarget(run.annotationId) } : {}),
        ...(run.relationshipId ? { relationshipId: normalizeTarget(run.relationshipId) } : {}),
        ...(run.targetIds ? { targetIds: run.targetIds.map(normalizeTarget) } : {}),
      }))
    }
    return normalized
  }
  return {
    version: PUBLICATION_CONFORMANCE_VERSION,
    id: 'publication',
    metadata: {
      ...parsed.metadata,
      // Source document revisions/dates can differ while the semantic subset
      // remains identical; they belong in provenance receipts instead.
      sourceDocumentVersion: undefined,
      created: undefined,
      modified: undefined,
      artifactModifiedAt: undefined,
    },
    edition: { locale: parsed.edition.locale, direction: parsed.edition.direction },
    nodes: parsed.nodes.map(normalizeNode),
  }
}

export function serializeCanonicalPublicationSubset(value: PublicationGraph | PublicationSourceResult) {
  return JSON.stringify(canonicalPublicationSubset(value))
}

export function canonicalPublicationSubsetSha256(value: PublicationGraph | PublicationSourceResult) {
  return sha256(serializeCanonicalPublicationSubset(value))
}

export function comparePublicationSemanticSubset(
  left: PublicationGraph | PublicationSourceResult,
  right: PublicationGraph | PublicationSourceResult,
) {
  return serializeCanonicalPublicationSubset(left) === serializeCanonicalPublicationSubset(right)
}

export function sourceReceiptHashes(value: PublicationSourceResult) {
  return {
    sourceType: value.provenance.sourceType,
    sourceId: value.provenance.sourceId,
    sourceRevision: value.provenance.sourceRevision,
    graphSha256: sha256(serializePublicationGraph(value.graph)),
    assetBundleSha256: sha256(serializeAssetBundle(value.assetBundle)),
    canonicalSubsetSha256: canonicalPublicationSubsetSha256(value),
  }
}
