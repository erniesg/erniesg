import { createHash } from 'node:crypto'
import { publicationGraphSchema, serializePublicationGraph, type PublicationGraph, type PublicationNode } from './schema'
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
  const relationshipIds = parsed.nodes.flatMap((node) =>
    'inlineRuns' in node && node.inlineRuns
      ? node.inlineRuns.flatMap((run) =>
          run.relationshipId ? [run.relationshipId] : [],
        )
      : [],
  )
  const relationshipIdMap = new Map(
    [...new Set(relationshipIds)].map((id, index) => [
      id,
      `relationship-${index + 1}`,
    ]),
  )
  const normalizeTarget = (target: string) => idMap.get(target) ?? target
  const normalizeRelationshipId = (id: string) =>
    relationshipIdMap.get(id) ?? id
  const normalizeHref = (href: string) =>
    href.startsWith('#') ? `#${normalizeTarget(href.slice(1))}` : href
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
    if ('backlinkIds' in node)
      normalized.backlinkIds = node.backlinkIds.map(normalizeRelationshipId)
    if ('targetIds' in node) normalized.targetIds = node.targetIds.map(normalizeTarget)
    if ('href' in node && node.href) normalized.href = normalizeHref(node.href)
    if ('inlineRuns' in node && node.inlineRuns) {
      normalized.inlineRuns = node.inlineRuns.map((run) => ({
        ...run,
        ...(run.href ? { href: normalizeHref(run.href) } : {}),
        ...(run.annotationId ? { annotationId: normalizeTarget(run.annotationId) } : {}),
        ...(run.relationshipId
          ? { relationshipId: normalizeRelationshipId(run.relationshipId) }
          : {}),
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

/** Build a renderer-safe graph from the canonical semantic subset while
 * retaining source provenance for receipt binding and checker attestation. */
export function canonicalPublicationGraph(
  value: PublicationGraph | PublicationSourceResult,
): PublicationGraph {
  const graph = 'graph' in value ? value.graph : value
  const canonical = canonicalPublicationSubset(graph)
  return publicationGraphSchema.parse({
    ...canonical,
    edition: { id: 'edition', ...canonical.edition },
    nodes: canonical.nodes.map((node, index) => ({
      ...node,
      provenance: graph.nodes[index]!.provenance,
    })),
  })
}

export function canonicalPublicationSourceResult(
  value: PublicationSourceResult,
): PublicationSourceResult {
  return { ...value, graph: canonicalPublicationGraph(value) }
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}

/**
 * Project a renderer/check receipt onto the fields that equivalent adapters
 * must share. Source identity, revisions, mapping versions, and raw graph/asset
 * hashes are the explicit allowlist of differences. Every source-receipt key is
 * validated before projection so a new policy cannot be silently allowlisted.
 */
export function publicationOutputReceiptContract(receipt: unknown) {
  if (!isRecord(receipt) || receipt.version !== '1.0.0')
    throw new Error('Publication output receipt has no supported version')
  const allowedReceiptKeys = new Set([
    'version',
    'source',
    'profiles',
    'policyVersions',
    'toolchain',
    'repository',
    'artifacts',
  ])
  const unsupportedReceiptKey = Object.keys(receipt).find(
    (key) => !allowedReceiptKeys.has(key),
  )
  if (unsupportedReceiptKey)
    throw new Error(
      `Publication output receipt has unsupported output receipt key: ${unsupportedReceiptKey}`,
    )
  const source = receipt.source
  const allowedSourceKeys = new Set([
    'adapterId',
    'adapterVersion',
    'sourceType',
    'sourceId',
    'sourceRevision',
    'mappingVersion',
    'graphSha256',
    'assetBundleSha256',
    'canonicalSubsetSha256',
    'routeParity',
  ])
  if (isRecord(source)) {
    const unsupported = Object.keys(source).find(
      (key) => !allowedSourceKeys.has(key),
    )
    if (unsupported)
      throw new Error(
        `Publication output receipt has unsupported source receipt key: ${unsupported}`,
      )
  }
  const requiredSourceStrings = [
    'adapterId',
    'adapterVersion',
    'sourceType',
    'sourceId',
    'graphSha256',
    'assetBundleSha256',
    'canonicalSubsetSha256',
    'routeParity',
  ] as const
  const optionalSourceStrings = ['sourceRevision', 'mappingVersion'] as const
  if (
    !isRecord(source) ||
    requiredSourceStrings.some(
      (key) => typeof source[key] !== 'string' || source[key].length === 0,
    ) ||
    optionalSourceStrings.some(
      (key) => source[key] !== undefined &&
        (typeof source[key] !== 'string' || source[key].length === 0),
    ) ||
    !['astro-canonical-route', 'not-applicable', 'adapter-conformance'].includes(
      String(source.routeParity),
    ) ||
    !isRecord(receipt.profiles) ||
    !isRecord(receipt.policyVersions) ||
    !isRecord(receipt.toolchain) ||
    !isRecord(receipt.repository) ||
    !Array.isArray(receipt.artifacts)
  )
    throw new Error('Publication output receipt is missing its shared contract')
  return {
    version: receipt.version,
    sourceAdapterVersion: source.adapterVersion,
    canonicalSubsetSha256: source.canonicalSubsetSha256,
    routeParity: source.routeParity,
    profiles: receipt.profiles,
    policyVersions: receipt.policyVersions,
    toolchain: receipt.toolchain,
    repository: receipt.repository,
    artifacts: receipt.artifacts,
  }
}

export function comparePublicationOutputReceipts(left: unknown, right: unknown) {
  return (
    stableJson(publicationOutputReceiptContract(left)) ===
    stableJson(publicationOutputReceiptContract(right))
  )
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
