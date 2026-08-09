import { createHash } from 'node:crypto'
import { publicationGraphSchema, serializePublicationGraph, type PublicationGraph, type PublicationNode } from './schema'
import { createAssetBundle, serializeAssetBundle, type AssetDescriptor } from './asset-bundle'
import type { PublicationSourceResult } from './source-adapter'

export const PUBLICATION_CONFORMANCE_VERSION = '1.0.0' as const

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
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

function codeUnitCompare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

type PublicationSemanticInput =
  | PublicationGraph
  | Pick<PublicationSourceResult, 'graph' | 'assetBundle'>

function structurallyOrderedNodes(graph: PublicationGraph) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const ownedIds = new Set<string>()
  for (const node of graph.nodes) {
    if (node.type === 'list') node.itemIds.forEach((id) => ownedIds.add(id))
    if (node.type === 'list-item')
      node.childListIds.forEach((id) => ownedIds.add(id))
    if ('captionId' in node && node.captionId) ownedIds.add(node.captionId)
  }
  const ordered: PublicationNode[] = []
  const visited = new Set<string>()
  const visit = (node: PublicationNode | undefined) => {
    if (!node || visited.has(node.id)) return
    visited.add(node.id)
    ordered.push(node)
    if (node.type === 'list')
      for (const itemId of node.itemIds) visit(byId.get(itemId))
    if (node.type === 'list-item')
      for (const childListId of node.childListIds)
        visit(byId.get(childListId))
    if ('captionId' in node && node.captionId) visit(byId.get(node.captionId))
  }
  for (const node of graph.nodes)
    if (!ownedIds.has(node.id)) visit(node)
  for (const node of graph.nodes) visit(node)
  return ordered
}

function sharedAssetSemantics(descriptor: AssetDescriptor) {
  return {
    sha256: descriptor.sha256,
    byteLength: descriptor.byteLength,
    mediaType: descriptor.mediaType,
    ...(descriptor.width !== undefined ? { width: descriptor.width } : {}),
    ...(descriptor.height !== undefined ? { height: descriptor.height } : {}),
    ...(descriptor.focalPoint ? { focalPoint: descriptor.focalPoint } : {}),
    ...(descriptor.crop ? { crop: descriptor.crop } : {}),
  }
}

function canonicalAssetProjection(value: PublicationSemanticInput) {
  if (!('graph' in value))
    return {
      assetIdMap: new Map<string, string>(),
      entries: undefined,
    }
  const entries = value.assetBundle.descriptor.assets
    .map((original) => ({ original, semantics: sharedAssetSemantics(original) }))
    .sort((left, right) => {
      const semanticOrder = codeUnitCompare(
        stableJson(left.semantics),
        stableJson(right.semantics),
      )
      return semanticOrder || codeUnitCompare(left.original.id, right.original.id)
    })
    .map(({ original, semantics }, index) => ({
      original,
      canonical: {
        id: `asset-${index + 1}`,
        ...semantics,
      } satisfies AssetDescriptor,
    }))
  return {
    assetIdMap: new Map(
      entries.map(({ original, canonical }) => [original.id, canonical.id]),
    ),
    entries,
  }
}

/**
 * Remove adapter/source identity while retaining the meaning graph.  Node
 * identifiers are normalized by structural reading order so equivalent Astro
 * and Payload fixtures can use different source ids and flat storage layouts
 * without weakening ownership or relationship checks.
 */
function canonicalProjection(value: PublicationSemanticInput) {
  const graph = 'graph' in value ? value.graph : value
  const orderedNodes = structurallyOrderedNodes(graph)
  const idMap = new Map(
    orderedNodes.map((node, index) => [node.id, `node-${index + 1}`]),
  )
  const tableCellIdMap = new Map<string, string>()
  for (const node of orderedNodes) {
    if (node.type !== 'table') continue
    const canonicalNodeId = idMap.get(node.id) ?? node.id
    node.rows.forEach((row, rowIndex) =>
      row.cells.forEach((cell, cellIndex) => {
        if (cell.id)
          tableCellIdMap.set(
            cell.id,
            `${canonicalNodeId}-cell-${rowIndex + 1}-${cellIndex + 1}`,
          )
      }),
    )
  }
  const assetProjection = canonicalAssetProjection(value)
  const relationshipIds = orderedNodes.flatMap((node) =>
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
  const normalizeRenderedAnchor = (target: string) =>
    idMap.get(target) ?? tableCellIdMap.get(target) ?? target
  const normalizeRelationshipId = (id: string) =>
    relationshipIdMap.get(id) ?? id
  const normalizeAssetId = (id: string) =>
    assetProjection.assetIdMap.get(id) ?? id
  const normalizeHref = (href: string) =>
    href.startsWith('#') ? `#${normalizeRenderedAnchor(href.slice(1))}` : href
  const normalizeNode = (node: PublicationNode) => {
    const { provenance: _provenance, edition: nodeEdition, id: _id, ...rest } = node
    const canonicalNodeId = idMap.get(node.id) ?? node.id
    const edition = {
      editionId: 'edition',
      ...(nodeEdition.equivalentNodeId
        ? { equivalentNodeId: normalizeTarget(nodeEdition.equivalentNodeId) }
        : {}),
    }
    const normalized: Record<string, unknown> = {
      ...rest,
      edition,
      id: canonicalNodeId,
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
    if (node.type === 'figure')
      normalized.assetIds = node.assetIds.map(normalizeAssetId)
    if (node.type === 'media') normalized.assetId = normalizeAssetId(node.assetId)
    normalized.variants = node.variants.map((variant) => ({
      ...variant,
      ...(variant.assetId
        ? { assetId: normalizeAssetId(variant.assetId) }
        : {}),
    }))
    if (node.type === 'table') {
      normalized.rows = node.rows.map((row) => ({
        cells: row.cells.map((cell) => ({
          ...cell,
          ...(cell.id
            ? { id: tableCellIdMap.get(cell.id) ?? cell.id }
            : {}),
          ...(cell.headerIds
            ? {
                headerIds: cell.headerIds.map(
                  (headerId) => tableCellIdMap.get(headerId) ?? headerId,
                ),
              }
            : {}),
        })),
      }))
    }
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
  const nodes = orderedNodes.map(normalizeNode)
  return {
    provenanceByCanonicalId: new Map(
      nodes.map((node, index) => [node.id as string, orderedNodes[index]!.provenance]),
    ),
    assetProjection,
    subset: {
      version: PUBLICATION_CONFORMANCE_VERSION,
      id: 'publication',
      metadata: {
        ...graph.metadata,
        // Source document revisions/dates can differ while the semantic subset
        // remains identical; they belong in provenance receipts instead.
        sourceDocumentVersion: undefined,
        created: undefined,
        modified: undefined,
        artifactModifiedAt: undefined,
      },
      edition: { locale: graph.edition.locale, direction: graph.edition.direction },
      nodes,
      ...(assetProjection.entries
        ? {
            assets: assetProjection.entries.map(({ canonical }) => canonical),
          }
        : {}),
    },
  }
}

export function canonicalPublicationSubset(value: PublicationSemanticInput) {
  return canonicalProjection(value).subset
}

export function serializeCanonicalPublicationSubset(value: PublicationSemanticInput) {
  return JSON.stringify(canonicalPublicationSubset(value))
}

export function canonicalPublicationSubsetSha256(value: PublicationSemanticInput) {
  return sha256(serializeCanonicalPublicationSubset(value))
}

export function comparePublicationSemanticSubset(
  left: PublicationSemanticInput,
  right: PublicationSemanticInput,
) {
  return serializeCanonicalPublicationSubset(left) === serializeCanonicalPublicationSubset(right)
}

/** Build a renderer-safe graph from the canonical semantic subset while
 * retaining source provenance for receipt binding and checker attestation. */
export function canonicalPublicationGraph(
  value: PublicationSemanticInput,
): PublicationGraph {
  const graph = 'graph' in value ? value.graph : value
  const projection = canonicalProjection(graph)
  const { assets: _assets, ...canonical } = projection.subset
  return publicationGraphSchema.parse({
    ...canonical,
    edition: { id: 'edition', ...canonical.edition },
    nodes: canonical.nodes.map((node) => ({
      ...node,
      provenance: projection.provenanceByCanonicalId.get(node.id as string),
    })),
  })
}

export function canonicalPublicationSourceResult(
  value: PublicationSourceResult,
): PublicationSourceResult {
  const projection = canonicalProjection(value)
  const { assets: _assets, ...canonical } = projection.subset
  const graph = publicationGraphSchema.parse({
    ...canonical,
    edition: { id: 'edition', ...canonical.edition },
    nodes: canonical.nodes.map((node) => ({
      ...node,
      provenance: projection.provenanceByCanonicalId.get(node.id as string),
    })),
  })
  const originalByCanonicalId = new Map(
    projection.assetProjection.entries?.map(({ original, canonical: asset }) => [
      asset.id,
      original,
    ]),
  )
  const assetBundle = createAssetBundle(
    {
      version: value.assetBundle.descriptor.version,
      assets:
        projection.assetProjection.entries?.map(({ canonical: asset }) =>
          asset,
        ) ?? [],
    },
    async (descriptor) => {
      const original = originalByCanonicalId.get(descriptor.id)
      if (!original)
        throw new Error(`Canonical asset ${descriptor.id} has no source descriptor`)
      return value.assetBundle.resolveBytes(original)
    },
  )
  return { ...value, graph, assetBundle }
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
