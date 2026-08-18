import { z } from 'zod'
import { sha256HexSync } from './sha256-sync.ts'
import type { PdfReconstruction } from './import-types'

/**
 * The model-facing extraction contract is intentionally smaller than the
 * publication graph.  Models may suggest references to source runs and
 * deterministic assets; they never supply authoritative text or bytes.
 */
export const STRUCTURED_EXTRACTION_SCHEMA_VERSION = '1.0.0' as const

export const STRUCTURED_EXTRACTION_NODE_TYPES = [
  'title',
  'author',
  'affiliation',
  'abstract',
  'heading',
  'paragraph',
  'code',
  'table',
  'figure',
  'equation',
  'footnote',
  'reference',
  'source-fallback',
] as const

export type StructuredExtractionNodeType =
  (typeof STRUCTURED_EXTRACTION_NODE_TYPES)[number]

export const STRUCTURED_EXTRACTION_LAYOUTS = [
  'one-column',
  'two-column',
  'multi-region',
] as const

export type StructuredExtractionLayout =
  (typeof STRUCTURED_EXTRACTION_LAYOUTS)[number]

export const STRUCTURED_EXTRACTION_SPLITS = ['development', 'held-out'] as const

export type StructuredExtractionSplit =
  (typeof STRUCTURED_EXTRACTION_SPLITS)[number]

export type StructuredSourceRun = {
  id: string
  text: string
  page: number
  order: number
  sourceSequenceIndex?: number
  /** Stable deterministic line ownership for whitespace-sensitive material. */
  lineId?: string
  /** A source run is already normalized by the deterministic extractor. */
  layout?: StructuredExtractionLayout
  regionId?: string
  bounds?: { x: number; y: number; width: number; height: number }
  stratum?: string
}

export type StructuredSourceLine = {
  id: string
  /** Canonical deterministic line text, including inferred run boundaries. */
  text: string
  sourceRunIds: string[]
}

export type StructuredSourceAsset = {
  id: string
  kind: 'figure' | 'diagram' | 'table' | 'equation' | 'source-fallback'
  required?: boolean
  page: number
  bounds: {
    x: number
    y: number
    width: number
    height: number
  }
  bytesSha256: string
  sourceObjectIds: string[]
  captionRunIds?: string[]
}

export type StructuredRegionTopology = {
  regions: Array<{
    id: string
    page: number
    order: number
    role: 'body' | 'heading' | 'figure' | 'table' | 'margin' | 'other'
    bounds: { x: number; y: number; width: number; height: number }
  }>
  edges: Array<{ fromRegionId: string; toRegionId: string }>
}

export type StructuredSourceLink = {
  id: string
  page: number
  sourceRunIds: string[]
  /** Exact deterministic assets that own a non-text annotation anchor. */
  sourceAssetIds?: string[]
  /** Exact native PDF objects beneath the linked deterministic asset. */
  sourceObjectIds?: string[]
  box: { x: number; y: number; width: number; height: number }
  destination:
    | { kind: 'external'; url: string }
    | { kind: 'internal'; targetId: string }
    | { kind: 'unresolved'; reason: string }
}

/** Owner-local page evidence shared by every extraction arm. */
export type StructuredExtractionPageRendition = {
  id?: string
  page: number
  mediaType?: string
  width?: number
  height?: number
  bytesSha256?: string
  reference?: string
  data?: string
}

export type StructuredProvenArtifact = {
  id: string
  kind:
    | 'region-lane'
    | 'table-scope'
    | 'line-boundary'
    | 'note-relationship'
    | 'citation-relationship'
    | 'cross-reference-relationship'
    | 'visual-relationship'
    | 'reading-order-relationship'
    | 'source-run-provenance'
  sourceRunIds: string[]
  /** Deterministic destination ownership for note/citation relationships. */
  targetSourceRunIds?: string[]
  /** One exact destination group per deterministic relationship target. */
  targetSourceRunIdGroups?: string[][]
  /** Exact deterministic table grid owned by a table-scope artifact. */
  tableRows?: Array<{
    cells: Array<{
      sourceRunIds: string[]
      rowSpan: number
      columnSpan: number
      headerScope: 'row' | 'column' | 'rowgroup' | 'colgroup' | 'none'
    }>
  }>
}

export type StructuredExtractionContext = {
  documentId: string
  sourceSha256: string
  split: StructuredExtractionSplit
  layout: StructuredExtractionLayout
  regionTopology?: StructuredRegionTopology
  sourceRuns: StructuredSourceRun[]
  sourceLines?: StructuredSourceLine[]
  sourceAssets: StructuredSourceAsset[]
  sourceLinks?: StructuredSourceLink[]
  pageRenditions?: StructuredExtractionPageRendition[]
  provenArtifacts?: StructuredProvenArtifact[]
  /** These runs remain accounted for but may not enter body flow. */
  boilerplateRunIds?: string[]
  /** Ground truth is deliberately not part of this model input. */
  readonly groundTruth?: never
}

export type StructuredExtractionTableCell = {
  sourceRunIds: string[]
  headerScope?: 'row' | 'column' | 'rowgroup' | 'colgroup' | 'none'
  rowSpan?: number
  columnSpan?: number
}

export type StructuredExtractionTable = {
  rows: Array<{ cells: StructuredExtractionTableCell[] }>
}

export type StructuredExtractionRelationships = {
  noteTargetNodeIds?: string[]
  citationTargetNodeIds?: string[]
  backlinks?: string[]
}

export type StructuredExtractionNode = {
  id: string
  type: StructuredExtractionNodeType
  sourceRunIds: string[]
  /** Optional proposal text. The verifier replaces it with source text. */
  text?: string
  level?: number
  assetId?: string
  captionNodeId?: string
  altText?: string
  altTextSource?: 'caption' | 'model' | 'image'
  table?: StructuredExtractionTable
  relationships?: StructuredExtractionRelationships
}

export type StructuredExtractionProposal = {
  schemaVersion?: typeof STRUCTURED_EXTRACTION_SCHEMA_VERSION
  nodes: StructuredExtractionNode[]
  /** All deterministic assets that the model associates with the flow. */
  assetIds?: string[]
  links?: Array<{ sourceLinkId: string; sourceNodeId: string }>
  /** Explicit accounting for page furniture omitted from body flow. */
  excludedBoilerplateRunIds?: string[]
  /** Optional model diagnostics are never copied to the publication graph. */
  diagnostics?: string[]
}

export type VerifiedStructuredExtractionNode = Omit<
  StructuredExtractionNode,
  'text' | 'altText' | 'altTextSource' | 'table'
> & {
  text: string
  provenance: {
    sourceRunIds: string[]
  }
  altText?: string
  altTextSource?: 'caption'
  table?: {
    rows: Array<{
      cells: Array<{
        text: string
        sourceRunIds: string[]
        headerScope: NonNullable<StructuredExtractionTableCell['headerScope']>
        rowSpan: number
        columnSpan: number
      }>
    }>
  }
}

export type VerifiedStructuredExtraction = {
  schemaVersion: typeof STRUCTURED_EXTRACTION_SCHEMA_VERSION
  documentId: string
  sourceSha256: string
  nodes: VerifiedStructuredExtractionNode[]
  assetIds: string[]
  excludedBoilerplateRunIds: string[]
  accountedSourceRunIds: string[]
  links: Array<{
    sourceLinkId: string
    sourceNodeId: string
    destination: StructuredSourceLink['destination']
  }>
  relationshipIds: string[]
}

export type StructuredExtractionVerificationIssueCode =
  | 'invalid-output'
  | 'unknown-source-run'
  | 'unverified-span'
  | 'source-text-mismatch'
  | 'duplicate-source-run'
  | 'boilerplate-in-body'
  | 'boilerplate-not-accounted'
  | 'unknown-asset'
  | 'asset-kind-mismatch'
  | 'asset-identity-mismatch'
  | 'asset-bytes-or-bounds-authored'
  | 'missing-caption'
  | 'model-authored-alt-text'
  | 'invalid-heading-level'
  | 'invalid-table'
  | 'invalid-relationship'
  | 'missing-source-run'
  | 'missing-asset'
  | 'duplicate-asset'
  | 'missing-link'
  | 'duplicate-link'
  | 'invalid-link'
  | 'semantic-role-mismatch'
  | 'invalid-region-topology'

export type StructuredExtractionVerificationIssue = {
  code: StructuredExtractionVerificationIssueCode
  nodeId?: string
  sourceRunId?: string
  assetId?: string
  message: string
}

export type StructuredExtractionVerificationResult =
  | {
      status: 'passed'
      output: VerifiedStructuredExtraction
      issues: []
    }
  | {
      status: 'failed'
      output: null
      issues: StructuredExtractionVerificationIssue[]
    }

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const idSchema = z.string().min(1).max(256)
const sourceRunSchema = z
  .object({
    id: idSchema,
    text: z.string(),
    page: z.number().int().positive(),
    order: z.number().int().nonnegative(),
    sourceSequenceIndex: z.number().int().nonnegative().optional(),
    lineId: idSchema.optional(),
    layout: z.enum(STRUCTURED_EXTRACTION_LAYOUTS).optional(),
    regionId: idSchema.optional(),
    bounds: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().positive(),
        height: z.number().positive(),
      })
      .strict()
      .optional(),
    stratum: z.string().min(1).optional(),
  })
  .strict()

const sourceAssetSchema = z
  .object({
    id: idSchema,
    kind: z.enum(['figure', 'diagram', 'table', 'equation', 'source-fallback']),
    required: z.boolean().optional(),
    page: z.number().int().positive(),
    bounds: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().positive(),
        height: z.number().positive(),
      })
      .strict(),
    bytesSha256: sha256Schema,
    sourceObjectIds: z.array(idSchema),
    captionRunIds: z.array(idSchema).optional(),
  })
  .strict()

const boundsSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .strict()

const regionTopologySchema = z
  .object({
    regions: z.array(
      z
        .object({
          id: idSchema,
          page: z.number().int().positive(),
          order: z.number().int().nonnegative(),
          role: z.enum([
            'body',
            'heading',
            'figure',
            'table',
            'margin',
            'other',
          ]),
          bounds: boundsSchema,
        })
        .strict(),
    ),
    edges: z.array(
      z.object({ fromRegionId: idSchema, toRegionId: idSchema }).strict(),
    ),
  })
  .strict()

const sourceLinkSchema = z
  .object({
    id: idSchema,
    page: z.number().int().positive(),
    sourceRunIds: z.array(idSchema),
    sourceAssetIds: z.array(idSchema).optional(),
    sourceObjectIds: z.array(idSchema).optional(),
    box: boundsSchema,
    destination: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('external'), url: z.string().url() }).strict(),
      z.object({ kind: z.literal('internal'), targetId: idSchema }).strict(),
      z
        .object({ kind: z.literal('unresolved'), reason: z.string().min(1) })
        .strict(),
    ]),
  })
  .strict()

const sourceLineSchema = z
  .object({
    id: idSchema,
    text: z.string(),
    sourceRunIds: z.array(idSchema).min(1),
  })
  .strict()

const pageRenditionSchema = z
  .object({
    id: idSchema.optional(),
    page: z.number().int().positive(),
    mediaType: z.string().min(1).optional(),
    width: z.number().finite().positive().optional(),
    height: z.number().finite().positive().optional(),
    bytesSha256: sha256Schema.optional(),
    reference: z.string().min(1).optional(),
    data: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    ({ reference, data }) => reference !== undefined || data !== undefined,
  )

const sourceArtifactSchema = z
  .object({
    id: idSchema,
    kind: z.enum([
      'region-lane',
      'table-scope',
      'line-boundary',
      'note-relationship',
      'citation-relationship',
      'cross-reference-relationship',
      'visual-relationship',
      'reading-order-relationship',
      'source-run-provenance',
    ]),
    sourceRunIds: z.array(idSchema),
    targetSourceRunIds: z.array(idSchema).optional(),
    targetSourceRunIdGroups: z.array(z.array(idSchema).min(1)).optional(),
    tableRows: z
      .array(
        z
          .object({
            cells: z
              .array(
                z
                  .object({
                    sourceRunIds: z.array(idSchema).min(1),
                    rowSpan: z.number().int().positive(),
                    columnSpan: z.number().int().positive(),
                    headerScope: z.enum([
                      'row',
                      'column',
                      'rowgroup',
                      'colgroup',
                      'none',
                    ]),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .min(1)
      .optional(),
  })
  .strict()

const contextSchema = z
  .object({
    documentId: idSchema,
    sourceSha256: sha256Schema,
    split: z.enum(STRUCTURED_EXTRACTION_SPLITS),
    layout: z.enum(STRUCTURED_EXTRACTION_LAYOUTS),
    regionTopology: regionTopologySchema.optional(),
    sourceRuns: z.array(sourceRunSchema),
    sourceLines: z.array(sourceLineSchema).optional(),
    sourceAssets: z.array(sourceAssetSchema),
    sourceLinks: z.array(sourceLinkSchema).optional(),
    pageRenditions: z.array(pageRenditionSchema).min(1).optional(),
    provenArtifacts: z.array(sourceArtifactSchema).optional(),
    boilerplateRunIds: z.array(idSchema).optional(),
  })
  .strict()

const tableCellSchema = z
  .object({
    sourceRunIds: z.array(idSchema).min(1),
    headerScope: z
      .enum(['row', 'column', 'rowgroup', 'colgroup', 'none'])
      .optional(),
    rowSpan: z.number().int().positive().optional(),
    columnSpan: z.number().int().positive().optional(),
  })
  .strict()

const relationshipsSchema = z
  .object({
    noteTargetNodeIds: z.array(idSchema).min(1).optional(),
    citationTargetNodeIds: z.array(idSchema).min(1).optional(),
    backlinks: z.array(idSchema).min(1).optional(),
  })
  .strict()
  .refine(
    ({ noteTargetNodeIds, citationTargetNodeIds, backlinks }) =>
      noteTargetNodeIds !== undefined ||
      citationTargetNodeIds !== undefined ||
      backlinks !== undefined,
  )

const nodeSchema = z
  .object({
    id: idSchema,
    type: z.enum(STRUCTURED_EXTRACTION_NODE_TYPES),
    sourceRunIds: z.array(idSchema).min(1),
    text: z.string().optional(),
    level: z.number().int().min(1).max(6).optional(),
    assetId: idSchema.optional(),
    captionNodeId: idSchema.optional(),
    altText: z.string().optional(),
    altTextSource: z.enum(['caption', 'model', 'image']).optional(),
    relationships: relationshipsSchema.optional(),
    table: z
      .object({ rows: z.array(z.object({ cells: z.array(tableCellSchema) })) })
      .strict()
      .optional(),
  })
  .strict()

const proposalSchema = z
  .object({
    schemaVersion: z.literal(STRUCTURED_EXTRACTION_SCHEMA_VERSION).optional(),
    nodes: z.array(nodeSchema).min(1),
    assetIds: z.array(idSchema).optional(),
    links: z
      .array(
        z.object({ sourceLinkId: idSchema, sourceNodeId: idSchema }).strict(),
      )
      .optional(),
    excludedBoilerplateRunIds: z.array(idSchema).optional(),
    diagnostics: z.array(z.string()).optional(),
  })
  .strict()

function physicalRunIdentity(run: {
  page: number
  text: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  method: string
  fontName: string
  fontSize: number
  sourceSequenceIndex?: number
}) {
  return JSON.stringify(
    Number.isSafeInteger(run.sourceSequenceIndex)
      ? ['source-sequence', run.page, run.sourceSequenceIndex]
      : [
          'source-geometry',
          run.page,
          run.text,
          run.x,
          run.y,
          run.width,
          run.height,
          run.rotation,
          run.method,
          run.fontName,
          run.fontSize,
        ],
  )
}

/**
 * Adapt the deterministic PDF reconstruction into the arm-neutral context.
 * IDs are derived from region/line/run positions and are therefore stable for
 * a fixed reconstruction receipt; no source text is copied into a receipt.
 */
export function structuredExtractionContextFromReconstruction({
  reconstruction,
  documentId = reconstruction.source.fileName,
  split,
  layout,
  stratum,
  pageRenditions,
}: {
  reconstruction: PdfReconstruction
  documentId?: string
  split: StructuredExtractionSplit
  layout: StructuredExtractionLayout
  stratum?: string
  pageRenditions?: StructuredExtractionPageRendition[]
}): StructuredExtractionContext {
  const sourceRuns: StructuredSourceRun[] = []
  const sourceLines: StructuredSourceLine[] = []
  const runIdsByKey = new Map<string, string>()
  const regionRunCounts = new Map<string, number>()
  let order = 0
  for (const region of reconstruction.regions) {
    for (const line of region.lines) {
      const lineId = `${region.id}:${line.id}`
      const sourceRunIds: string[] = []
      for (const [runIndex, run] of line.runs.entries()) {
        const physicalIdentity = physicalRunIdentity(run)
        regionRunCounts.set(
          physicalIdentity,
          (regionRunCounts.get(physicalIdentity) ?? 0) + 1,
        )
        const id = `r-${region.id}-${line.id}-${runIndex}`
        sourceRunIds.push(id)
        runIdsByKey.set(`${region.id}\u0000${line.id}\u0000${runIndex}`, id)
        sourceRuns.push({
          id,
          text: run.text,
          page: run.page,
          order: order++,
          ...(Number.isSafeInteger(run.sourceSequenceIndex)
            ? { sourceSequenceIndex: run.sourceSequenceIndex }
            : {}),
          lineId,
          layout,
          regionId: region.id,
          bounds: {
            x: run.x,
            y: run.y,
            width: run.width,
            height: run.height,
          },
          ...(stratum ? { stratum } : {}),
        })
      }
      if (sourceRunIds.length > 0) {
        sourceLines.push({ id: lineId, text: line.text, sourceRunIds })
      }
    }
  }
  const unmatchedRegionRunCounts = new Map(regionRunCounts)
  for (const page of [...reconstruction.pages].sort(
    (left, right) => left.page - right.page,
  )) {
    for (const [runIndex, run] of page.runs.entries()) {
      const physicalIdentity = physicalRunIdentity(run)
      const remaining = unmatchedRegionRunCounts.get(physicalIdentity) ?? 0
      if (remaining > 0) {
        unmatchedRegionRunCounts.set(physicalIdentity, remaining - 1)
        continue
      }
      sourceRuns.push({
        id: `r-page-${page.page}-${runIndex}`,
        text: run.text,
        page: run.page,
        order: order++,
        ...(Number.isSafeInteger(run.sourceSequenceIndex)
          ? { sourceSequenceIndex: run.sourceSequenceIndex }
          : {}),
        layout,
        bounds: {
          x: run.x,
          y: run.y,
          width: run.width,
          height: run.height,
        },
        ...(stratum ? { stratum } : {}),
      })
    }
  }
  sourceRuns
    .sort((left, right) => {
      if (left.page !== right.page) return left.page - right.page
      if (
        left.sourceSequenceIndex !== undefined &&
        right.sourceSequenceIndex !== undefined &&
        left.sourceSequenceIndex !== right.sourceSequenceIndex
      ) {
        return left.sourceSequenceIndex - right.sourceSequenceIndex
      }
      return left.order - right.order
    })
    .forEach((run, sourceOrder) => {
      run.order = sourceOrder
    })
  const runIdsForRegion = (regionId: string) => {
    const region = reconstruction.regions.find(({ id }) => id === regionId)
    if (!region) return []
    return region.lines.flatMap((line) =>
      line.runs
        .map((_, runIndex) =>
          runIdsByKey.get(`${region.id}\u0000${line.id}\u0000${runIndex}`)!,
        )
        .filter(Boolean),
    )
  }
  const runIdsForNode = (nodeId: string | null) =>
    nodeId
      ? (reconstruction.provenance[nodeId]?.regionIds ?? []).flatMap(
          runIdsForRegion,
        )
      : []
  const retainedAssets = [
    ...reconstruction.assets,
    ...reconstruction.pages
      .flatMap(({ assets }) => assets ?? [])
      .filter(
        (asset) =>
          asset.rendition === 'source-page-render' &&
          !reconstruction.assets.some(({ id }) => id === asset.id),
      ),
  ]
  const sourceAssets: StructuredSourceAsset[] = retainedAssets.map((asset) => {
    const relationship = reconstruction.visualRelationships.find(
      ({ assetIds }) => assetIds.includes(asset.id),
    )
    const kind: StructuredSourceAsset['kind'] =
      asset.rendition === 'source-page-render'
        ? 'source-fallback'
        : asset.kind === 'table'
          ? 'table'
          : asset.kind === 'equation'
            ? 'equation'
            : relationship?.kind === 'figure'
              ? 'figure'
              : 'diagram'
    const box = asset.sourceCropBox ?? asset.sourceBoxes[0]
    return {
      id: asset.id,
      kind,
      page: box?.page ?? 1,
      bounds: {
        x: box?.x ?? 0,
        y: box?.y ?? 0,
        width: box?.width ?? 0.001,
        height: box?.height ?? 0.001,
      },
      bytesSha256: asset.sha256,
      sourceObjectIds: [...asset.sourceObjectIds],
      ...(relationship
        ? { captionRunIds: runIdsForRegion(relationship.captionRegionId) }
        : {}),
    }
  })
  const boilerplateRunIds = reconstruction.regions
    .filter((region) =>
      ['header', 'footer', 'page-number'].includes(region.kind),
    )
    .flatMap(({ id }) => runIdsForRegion(id))
  const regionTopology: StructuredRegionTopology = {
    regions: reconstruction.regions.map((region, regionOrder) => ({
      id: region.id,
      page: region.page,
      order: regionOrder,
      role: ['heading', 'figure', 'table'].includes(region.kind)
        ? (region.kind as 'heading' | 'figure' | 'table')
        : ['header', 'footer', 'page-number'].includes(region.kind)
          ? 'margin'
          : 'body',
      bounds: {
        x: region.box.x,
        y: region.box.y,
        width: region.box.width,
        height: region.box.height,
      },
    })),
    edges: reconstruction.readingOrder.edges
      .filter(({ status }) => status === 'accepted')
      .map(({ from, to }) => ({ fromRegionId: from, toRegionId: to })),
  }
  const sourceLinks: StructuredSourceLink[] = reconstruction.pages.flatMap(
    (page) =>
      (page.links ?? []).map((link, linkIndex) => {
        const box = 'box' in link && link.box ? link.box : null
        const linkId =
          'id' in link && typeof link.id === 'string'
            ? link.id
            : `link-${page.page}-${linkIndex + 1}`
        const provenRegionIds = Object.values(reconstruction.provenance)
          .filter(({ links }) =>
            links.some(
              (provenLink) =>
                ('id' in provenLink && provenLink.id === linkId) ||
                (!('id' in provenLink) &&
                  !('id' in link) &&
                  provenLink.url === link.url),
            ),
          )
          .flatMap(({ regionIds }) => regionIds)
        const sourceRunIds = [
          ...new Set(
            provenRegionIds.length > 0
              ? provenRegionIds.flatMap(runIdsForRegion)
              : sourceRuns
                  .filter(
                    (run) =>
                      box !== null &&
                      run.page === page.page &&
                      run.bounds !== undefined &&
                      Math.max(run.bounds.x, box.x) <
                        Math.min(
                          run.bounds.x + run.bounds.width,
                          box.x + box.width,
                        ) &&
                      Math.max(run.bounds.y, box.y) <
                        Math.min(
                          run.bounds.y + run.bounds.height,
                          box.y + box.height,
                        ),
                  )
                  .map(({ id }) => id),
          ),
        ]
        const destination: StructuredSourceLink['destination'] =
          'status' in link && link.status === 'internal'
            ? { kind: 'internal', targetId: link.destination }
            : 'url' in link && typeof link.url === 'string'
              ? { kind: 'external', url: link.url }
              : {
                  kind: 'unresolved',
                  reason:
                    'reason' in link && typeof link.reason === 'string'
                      ? link.reason
                      : 'unresolved-source-annotation',
                }
        const overlappingAssets = sourceAssets.filter(
          (asset) =>
            box !== null &&
            asset.page === page.page &&
            Math.max(asset.bounds.x, box.x) <
              Math.min(
                asset.bounds.x + asset.bounds.width,
                box.x + box.width,
              ) &&
            Math.max(asset.bounds.y, box.y) <
              Math.min(
                asset.bounds.y + asset.bounds.height,
                box.y + box.height,
              ),
        )
        return {
          id: linkId,
          page: page.page,
          sourceRunIds,
          ...(sourceRunIds.length === 0
            ? {
                sourceAssetIds: overlappingAssets.map(({ id }) => id).sort(),
                sourceObjectIds: [
                  ...new Set(
                    overlappingAssets.flatMap(
                      ({ sourceObjectIds }) => sourceObjectIds,
                    ),
                  ),
                ].sort(),
              }
            : {}),
          box: {
            x: box?.x ?? 0,
            y: box?.y ?? 0,
            width: box?.width ?? 1,
            height: box?.height ?? 1,
          },
          destination,
        }
      }),
  )
  const provenArtifacts: StructuredProvenArtifact[] = [
    ...reconstruction.regions.map((region) => ({
      id: region.id,
      kind: 'region-lane' as const,
      sourceRunIds: runIdsForRegion(region.id),
    })),
    ...reconstruction.visualRelationships
      .filter(({ kind }) => kind === 'table')
      .map((relationship) => {
        const tableNode = reconstruction.paper.nodes.find(
          (node) =>
            node.id === relationship.canonicalNodeId &&
            node.type === 'figure' &&
            node.objectType === 'table' &&
            node.table !== undefined,
        )
        const tableRows =
          tableNode?.type === 'figure' && tableNode.table
            ? tableNode.table.rows.map((row) => ({
                cells: row.cells.map((cell) => ({
                  sourceRunIds: (cell.sourceRuns ?? [])
                    .map(({ regionId, lineId, runIndex }) =>
                      runIdsByKey.get(
                        `${regionId}\u0000${lineId}\u0000${runIndex}`,
                      ),
                    )
                    .filter((id): id is string => id !== undefined),
                  rowSpan: cell.rowSpan,
                  columnSpan: cell.columnSpan,
                  headerScope: cell.headerScope ?? 'none',
                })),
              }))
            : undefined
        const closedTableRows = tableRows?.every(
          ({ cells }) =>
            cells.length > 0 &&
            cells.every(({ sourceRunIds }) => sourceRunIds.length > 0),
        )
          ? tableRows
          : undefined
        return {
          id: relationship.id,
          kind: 'table-scope' as const,
          sourceRunIds: relationship.sourceRegionIds.flatMap(runIdsForRegion),
          ...(closedTableRows ? { tableRows: closedTableRows } : {}),
        }
      }),
    ...reconstruction.lineBoundaryDecisions.map((decision) => ({
      id: decision.id,
      kind: 'line-boundary' as const,
      sourceRunIds: runIdsForRegion(decision.regionId),
    })),
    ...reconstruction.noteRelationships.map((relationship) => ({
      id: relationship.id,
      kind: 'note-relationship' as const,
      sourceRunIds: [relationship.referenceRegionId].flatMap(runIdsForRegion),
      targetSourceRunIdGroups: relationship.targetNoteId
        ? [runIdsForNode(relationship.targetNoteId)]
        : [],
    })),
    ...reconstruction.citationRelationships.map((relationship) => ({
      id: relationship.id,
      kind: 'citation-relationship' as const,
      sourceRunIds: [relationship.referenceRegionId].flatMap(runIdsForRegion),
      targetSourceRunIdGroups: relationship.targetNodeIds.map(runIdsForNode),
    })),
    ...reconstruction.crossReferenceRelationships.map((relationship) => ({
      id: relationship.id,
      kind: 'cross-reference-relationship' as const,
      sourceRunIds: runIdsForRegion(relationship.referenceRegionId),
      targetSourceRunIdGroups: relationship.targets
        .map(({ targetNodeId }) => runIdsForNode(targetNodeId))
        .filter((group) => group.length > 0),
    })),
    ...reconstruction.visualRelationships.map((relationship) => ({
      id: relationship.id,
      kind: 'visual-relationship' as const,
      sourceRunIds: [
        ...relationship.sourceRegionIds,
        relationship.captionRegionId,
      ].flatMap(runIdsForRegion),
    })),
    ...reconstruction.readingOrder.edges
      .filter(({ status }) => status === 'accepted')
      .map((relationship) => ({
        id: relationship.id,
        kind: 'reading-order-relationship' as const,
        sourceRunIds: [relationship.from, relationship.to].flatMap(
          runIdsForRegion,
        ),
      })),
    {
      id: 'source-run-provenance',
      kind: 'source-run-provenance' as const,
      sourceRunIds: sourceRuns.map(({ id }) => id),
    },
  ]
  return {
    documentId,
    sourceSha256: reconstruction.source.sha256,
    split,
    layout,
    ...(layout === 'multi-region' ? { regionTopology } : {}),
    sourceRuns,
    sourceLines,
    sourceAssets,
    ...(sourceLinks.length > 0 ? { sourceLinks } : {}),
    ...(pageRenditions ? { pageRenditions } : {}),
    provenArtifacts,
    boilerplateRunIds,
  }
}

function normalizedText(value: string) {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child)
    }
    Object.freeze(value)
  }
  return value
}

export function structuredExtractionStableJson(value: unknown) {
  return stableJson(value)
}

export function structuredExtractionHash(value: unknown) {
  return sha256HexSync(stableJson(value))
}

export function parseStructuredExtractionContext(
  value: unknown,
): StructuredExtractionContext {
  return contextSchema.parse(value)
}

export function parseStructuredExtractionProposal(
  value: unknown,
): StructuredExtractionProposal {
  return proposalSchema.parse(value) as StructuredExtractionProposal
}

function sourceTextForRunIds(
  sourceRunIds: readonly string[],
  runsById: ReadonlyMap<string, StructuredSourceRun>,
) {
  return normalizedText(
    sourceRunIds
      .map((id) => runsById.get(id)?.text ?? '')
      .filter((text) => text.length > 0)
      .join(' '),
  )
}

/**
 * A code listing's whitespace *is* its structure. Prose normalization collapses
 * every run of whitespace to one space, which republishes a source-backed
 * listing as a single flattened line, so preformatted nodes keep their source
 * bytes (NFKC-normalized, like prose) and are joined by line rather than space.
 */
const PREFORMATTED_NODE_TYPES: ReadonlySet<StructuredExtractionNodeType> =
  new Set(['code'])

function nodeTextForRunIds(
  type: StructuredExtractionNodeType,
  sourceRunIds: readonly string[],
  runsById: ReadonlyMap<string, StructuredSourceRun>,
  linesById: ReadonlyMap<string, StructuredSourceLine>,
) {
  if (!PREFORMATTED_NODE_TYPES.has(type))
    return sourceTextForRunIds(sourceRunIds, runsById)
  const runs = sourceRunIds
    .map((id) => runsById.get(id))
    .filter((run): run is StructuredSourceRun => run !== undefined)
  if (
    runs.length > 0 &&
    runs.every((run) => run.lineId !== undefined && linesById.has(run.lineId))
  ) {
    const lineIds = runs.flatMap(({ lineId }, index) =>
      lineId !== runs[index - 1]?.lineId ? [lineId!] : [],
    )
    return lineIds
      .map((lineId) => linesById.get(lineId)!.text)
      .join('\n')
      .normalize('NFKC')
  }
  return runs
    .map((run, index) => {
      const previous = runs[index - 1]
      const lineBreak =
        previous?.lineId !== undefined &&
        run.lineId !== undefined &&
        previous.lineId !== run.lineId
          ? '\n'
          : ''
      return `${lineBreak}${run.text}`
    })
    .join('')
    .normalize('NFKC')
}

function nodeOwnedSourceRunIds(node: StructuredExtractionNode) {
  return [
    ...node.sourceRunIds,
    ...(node.type === 'table'
      ? (node.table?.rows.flatMap(({ cells }) =>
          cells.flatMap(({ sourceRunIds }) => sourceRunIds),
        ) ?? [])
      : []),
  ]
}

function canonicalStringSet(values: readonly string[]) {
  return JSON.stringify([...new Set(values)].sort())
}

function issue(
  code: StructuredExtractionVerificationIssueCode,
  message: string,
  fields: Partial<StructuredExtractionVerificationIssue> = {},
): StructuredExtractionVerificationIssue {
  return { code, message, ...fields }
}

function verifyNodeTable(
  node: StructuredExtractionNode,
  runsById: ReadonlyMap<string, StructuredSourceRun>,
  provenArtifacts: readonly StructuredProvenArtifact[],
  claimed: Set<string>,
  issues: StructuredExtractionVerificationIssue[],
  boilerplate: ReadonlySet<string>,
) {
  if (node.type !== 'table') return undefined
  // A table node without semantic cells publishes no rows, header scopes, or
  // per-cell provenance, yet would score as a table. It is not a table.
  if (!node.table) {
    issues.push(
      issue('invalid-table', 'A table must carry its semantic cells.', {
        nodeId: node.id,
      }),
    )
    return undefined
  }
  if (node.table.rows.length === 0) {
    issues.push(
      issue('invalid-table', 'A table must contain at least one row.', {
        nodeId: node.id,
      }),
    )
    return undefined
  }
  const cellSourceRunIds = node.table.rows.flatMap(({ cells }) =>
    cells.flatMap(({ sourceRunIds }) => sourceRunIds),
  )
  const cellSourceRunCounts = new Map<string, number>()
  for (const sourceRunId of cellSourceRunIds) {
    cellSourceRunCounts.set(
      sourceRunId,
      (cellSourceRunCounts.get(sourceRunId) ?? 0) + 1,
    )
  }
  const proposedTableRows = node.table.rows.map((row) => ({
    cells: row.cells.map((cell) => ({
      sourceRunIds: [...cell.sourceRunIds],
      rowSpan: cell.rowSpan ?? 1,
      columnSpan: cell.columnSpan ?? 1,
      headerScope: cell.headerScope ?? 'none',
    })),
  }))
  const matchingScopes = provenArtifacts.filter((artifact) => {
    if (
      artifact.kind !== 'table-scope' ||
      artifact.sourceRunIds.length !== cellSourceRunIds.length
    ) {
      return false
    }
    const scopeCounts = new Map<string, number>()
    for (const sourceRunId of artifact.sourceRunIds) {
      scopeCounts.set(sourceRunId, (scopeCounts.get(sourceRunId) ?? 0) + 1)
    }
    const ownsExactScope =
      scopeCounts.size === cellSourceRunCounts.size &&
      [...scopeCounts].every(
        ([sourceRunId, count]) =>
          cellSourceRunCounts.get(sourceRunId) === count,
      )
    if (!ownsExactScope) return false
    return (
      artifact.tableRows === undefined ||
      stableJson(artifact.tableRows) === stableJson(proposedTableRows)
    )
  })
  if (matchingScopes.length !== 1) {
    issues.push(
      issue(
        'invalid-table',
        'Semantic table cells must exactly match one deterministic table scope.',
        { nodeId: node.id },
      ),
    )
  }
  const cellSourceOrders = cellSourceRunIds
    .map((sourceRunId) => runsById.get(sourceRunId)?.order)
    .filter((order): order is number => order !== undefined)
  if (
    cellSourceOrders.some(
      (order, index) => index > 0 && order < cellSourceOrders[index - 1]!,
    )
  ) {
    issues.push(
      issue(
        'unverified-span',
        'Table cells and rows must follow deterministic source order.',
        { nodeId: node.id },
      ),
    )
  }
  const rows: VerifiedStructuredExtractionNode['table'] = { rows: [] }
  for (const row of node.table.rows) {
    if (row.cells.length === 0) {
      issues.push(
        issue('invalid-table', 'A table row must contain cells.', {
          nodeId: node.id,
        }),
      )
      return undefined
    }
    const cells = []
    for (const cell of row.cells) {
      const cellText = sourceTextForRunIds(cell.sourceRunIds, runsById)
      if (!cellText) {
        issues.push(
          issue('unverified-span', 'A table cell has no source text.', {
            nodeId: node.id,
          }),
        )
        return undefined
      }
      for (const sourceRunId of cell.sourceRunIds) {
        if (boilerplate.has(sourceRunId)) {
          issues.push(
            issue(
              'boilerplate-in-body',
              `Boilerplate run ${sourceRunId} cannot enter a table cell.`,
              { nodeId: node.id, sourceRunId },
            ),
          )
        }
        if (!runsById.has(sourceRunId)) {
          issues.push(
            issue('unknown-source-run', `Unknown source run ${sourceRunId}.`, {
              nodeId: node.id,
              sourceRunId,
            }),
          )
        } else if (claimed.has(sourceRunId)) {
          issues.push(
            issue(
              'duplicate-source-run',
              `Source run ${sourceRunId} is emitted more than once.`,
              { nodeId: node.id, sourceRunId },
            ),
          )
        }
        claimed.add(sourceRunId)
      }
      cells.push({
        text: cellText,
        sourceRunIds: [...cell.sourceRunIds],
        headerScope: cell.headerScope ?? 'none',
        rowSpan: cell.rowSpan ?? 1,
        columnSpan: cell.columnSpan ?? 1,
      })
    }
    rows.rows.push({ cells })
  }
  return rows
}

function validateNodeText(
  node: StructuredExtractionNode,
  runsById: ReadonlyMap<string, StructuredSourceRun>,
  linesById: ReadonlyMap<string, StructuredSourceLine>,
  claimed: Set<string>,
  issues: StructuredExtractionVerificationIssue[],
) {
  if (!Array.isArray(node.sourceRunIds) || node.sourceRunIds.length === 0) {
    issues.push(
      issue(
        'unverified-span',
        'Every emitted node must reference source runs.',
        { nodeId: node.id },
      ),
    )
    return ''
  }
  const knownRuns = node.sourceRunIds
    .map((sourceRunId) => runsById.get(sourceRunId))
    .filter((run): run is StructuredSourceRun => run !== undefined)
  if (
    node.type === 'code' &&
    node.sourceRunIds.length > 1 &&
    knownRuns.length === node.sourceRunIds.length &&
    knownRuns.some(({ lineId }) => lineId === undefined)
  ) {
    issues.push(
      issue(
        'unverified-span',
        'Multi-run code requires deterministic line ownership.',
        { nodeId: node.id },
      ),
    )
  }
  if (node.type === 'code') {
    const selectedByLineId = new Map<string, string[]>()
    for (const run of knownRuns) {
      if (!run.lineId) continue
      const selected = selectedByLineId.get(run.lineId) ?? []
      selected.push(run.id)
      selectedByLineId.set(run.lineId, selected)
    }
    for (const [lineId, selected] of selectedByLineId) {
      const sourceLine = linesById.get(lineId)
      if (
        !sourceLine ||
        sourceLine.sourceRunIds.length !== selected.length ||
        sourceLine.sourceRunIds.some((id, index) => id !== selected[index])
      ) {
        issues.push(
          issue(
            'unverified-span',
            `Code line ${lineId} requires complete canonical line ownership.`,
            { nodeId: node.id },
          ),
        )
      }
    }
  }
  const text = nodeTextForRunIds(
    node.type,
    node.sourceRunIds,
    runsById,
    linesById,
  )
  if (!text) {
    issues.push(
      issue('unverified-span', 'A node references no readable source text.', {
        nodeId: node.id,
      }),
    )
  }
  const proposedText = PREFORMATTED_NODE_TYPES.has(node.type)
    ? node.text?.normalize('NFKC')
    : node.text === undefined
      ? undefined
      : normalizedText(node.text)
  if (node.text !== undefined && proposedText !== text) {
    issues.push(
      issue(
        'source-text-mismatch',
        'Model text does not exactly match the referenced source runs.',
        { nodeId: node.id },
      ),
    )
  }
  const sourceOrders = node.sourceRunIds
    .map((sourceRunId) => runsById.get(sourceRunId)?.order)
    .filter((order): order is number => order !== undefined)
  if (
    sourceOrders.some(
      (order, index) => index > 0 && order < sourceOrders[index - 1]!,
    )
  ) {
    issues.push(
      issue(
        'unverified-span',
        'Source runs must be emitted in deterministic source order.',
        { nodeId: node.id },
      ),
    )
  }
  for (const sourceRunId of node.sourceRunIds) {
    if (!runsById.has(sourceRunId)) {
      issues.push(
        issue('unknown-source-run', `Unknown source run ${sourceRunId}.`, {
          nodeId: node.id,
          sourceRunId,
        }),
      )
    } else if (claimed.has(sourceRunId)) {
      issues.push(
        issue(
          'duplicate-source-run',
          `Source run ${sourceRunId} is emitted more than once.`,
          { nodeId: node.id, sourceRunId },
        ),
      )
    }
    claimed.add(sourceRunId)
  }
  return text
}

function verifyAsset(
  node: StructuredExtractionNode,
  context: StructuredExtractionContext,
  assetsById: ReadonlyMap<string, StructuredSourceAsset>,
  nodesById: ReadonlyMap<string, StructuredExtractionNode>,
  issues: StructuredExtractionVerificationIssue[],
) {
  if (!node.assetId) {
    // Returning here for a figure skips every figure-specific check, so a
    // proposal that simply omits `assetId` publishes a figure with no bounded
    // asset, no caption, and no caption-derived alt text.
    if (node.type === 'figure') {
      issues.push(
        issue(
          'unknown-asset',
          `Figure ${node.id} must reference a deterministic asset.`,
          { nodeId: node.id },
        ),
      )
    }
    return
  }
  const asset = assetsById.get(node.assetId)
  if (!asset) {
    issues.push(
      issue('unknown-asset', `Unknown deterministic asset ${node.assetId}.`, {
        nodeId: node.id,
        assetId: node.assetId,
      }),
    )
    return
  }
  if (
    (node.type === 'figure' && !['figure', 'diagram'].includes(asset.kind)) ||
    (node.type === 'table' && asset.kind !== 'table') ||
    (node.type === 'equation' && asset.kind !== 'equation')
  ) {
    issues.push(
      issue(
        'asset-kind-mismatch',
        `Asset ${node.assetId} cannot back a ${node.type} node.`,
        { nodeId: node.id, assetId: node.assetId },
      ),
    )
  }
  // The proposal type has no bytes/bounds fields. Reject them defensively if
  // an untyped caller smuggles them in, rather than silently accepting model
  // authored geometry.
  const untyped = node as StructuredExtractionNode & Record<string, unknown>
  if ('bytes' in untyped || 'bounds' in untyped || 'bytesSha256' in untyped) {
    issues.push(
      issue(
        'asset-bytes-or-bounds-authored',
        `Asset ${node.assetId} bytes and bounds belong to the deterministic layer.`,
        { nodeId: node.id, assetId: node.assetId },
      ),
    )
  }
  if (node.type === 'figure') {
    if (!node.captionNodeId || !nodesById.has(node.captionNodeId)) {
      issues.push(
        issue(
          'missing-caption',
          `Figure ${node.id} must reference a source-backed caption.`,
          { nodeId: node.id, assetId: node.assetId },
        ),
      )
    } else if (node.altTextSource !== 'caption') {
      issues.push(
        issue(
          'model-authored-alt-text',
          `Figure ${node.id} alt text must be caption-derived.`,
          { nodeId: node.id, assetId: node.assetId },
        ),
      )
    } else {
      const caption = nodesById.get(node.captionNodeId)!
      const captionText = sourceTextForRunIds(
        caption.sourceRunIds,
        new Map(context.sourceRuns.map((run) => [run.id, run])),
      )
      if (
        asset.captionRunIds &&
        (asset.captionRunIds.length !== caption.sourceRunIds.length ||
          asset.captionRunIds.some(
            (runId, index) => runId !== caption.sourceRunIds[index],
          ))
      ) {
        issues.push(
          issue(
            'asset-identity-mismatch',
            `Figure ${node.id} caption does not match the deterministic asset caption ownership.`,
            { nodeId: node.id, assetId: node.assetId },
          ),
        )
      }
      if (
        node.altText !== undefined &&
        normalizedText(node.altText) !== captionText
      ) {
        issues.push(
          issue(
            'model-authored-alt-text',
            `Figure ${node.id} alt text does not equal its caption.`,
            { nodeId: node.id, assetId: node.assetId },
          ),
        )
      }
    }
  }
}

function captionTextForNode(
  node: StructuredExtractionNode,
  nodesById: ReadonlyMap<string, StructuredExtractionNode>,
  runsById: ReadonlyMap<string, StructuredSourceRun>,
) {
  if (!node.captionNodeId) return undefined
  const caption = nodesById.get(node.captionNodeId)
  return caption
    ? sourceTextForRunIds(caption.sourceRunIds, runsById)
    : undefined
}

function verifyRelationships(
  context: StructuredExtractionContext,
  proposal: StructuredExtractionProposal,
  nodesById: ReadonlyMap<string, StructuredExtractionNode>,
  issues: StructuredExtractionVerificationIssue[],
) {
  const provenArtifacts = context.provenArtifacts ?? []
  const targetGroupsForArtifact = (artifact: StructuredProvenArtifact) => [
    ...(artifact.targetSourceRunIdGroups ?? []),
    ...(artifact.targetSourceRunIds ? [artifact.targetSourceRunIds] : []),
  ]
  const targetMatchesGroup = (
    target: StructuredExtractionNode,
    group: readonly string[],
  ) => {
    const targetRuns = new Set(nodeOwnedSourceRunIds(target))
    const artifactTargetRuns = new Set(group)
    return (
      targetRuns.size > 0 &&
      artifactTargetRuns.size === targetRuns.size &&
      [...targetRuns].every((id) => artifactTargetRuns.has(id))
    )
  }
  const sourceMatchesArtifact = (
    source: StructuredExtractionNode,
    artifact: StructuredProvenArtifact,
  ) => {
    const sourceRuns = new Set(nodeOwnedSourceRunIds(source))
    const artifactSourceRuns = new Set(artifact.sourceRunIds)
    return (
      sourceRuns.size > 0 &&
      [...sourceRuns].every((id) => artifactSourceRuns.has(id))
    )
  }
  const relationshipIsProven = (
    source: StructuredExtractionNode,
    target: StructuredExtractionNode,
    kind: 'note-relationship' | 'citation-relationship',
  ) => {
    return provenArtifacts.some((artifact) => {
      if (artifact.kind !== kind) return false
      return (
        sourceMatchesArtifact(source, artifact) &&
        targetGroupsForArtifact(artifact).some((group) =>
          targetMatchesGroup(target, group),
        )
      )
    })
  }
  const targetLists = (node: StructuredExtractionNode) => [
    ...(node.relationships?.noteTargetNodeIds ?? []),
    ...(node.relationships?.citationTargetNodeIds ?? []),
  ]

  for (const node of proposal.nodes) {
    const relationships = node.relationships
    if (!relationships) continue
    const lists = [
      relationships.noteTargetNodeIds ?? [],
      relationships.citationTargetNodeIds ?? [],
      relationships.backlinks ?? [],
    ]
    if (lists.some((ids) => new Set(ids).size !== ids.length)) {
      issues.push(
        issue('invalid-relationship', 'Relationship targets must be unique.', {
          nodeId: node.id,
        }),
      )
    }

    for (const targetId of relationships.noteTargetNodeIds ?? []) {
      const target = nodesById.get(targetId)
      if (
        target?.type !== 'footnote' ||
        !target.relationships?.backlinks?.includes(node.id) ||
        !relationshipIsProven(node, target, 'note-relationship')
      ) {
        issues.push(
          issue(
            'invalid-relationship',
            `Note target ${targetId} must be a deterministically proven footnote with a reciprocal backlink.`,
            { nodeId: node.id },
          ),
        )
      }
    }

    for (const targetId of relationships.citationTargetNodeIds ?? []) {
      const target = nodesById.get(targetId)
      if (
        target?.type !== 'reference' ||
        !target.relationships?.backlinks?.includes(node.id) ||
        !relationshipIsProven(node, target, 'citation-relationship')
      ) {
        issues.push(
          issue(
            'invalid-relationship',
            `Citation target ${targetId} must be a deterministically proven reference with a reciprocal backlink.`,
            { nodeId: node.id },
          ),
        )
      }
    }

    for (const backlinkId of relationships.backlinks ?? []) {
      const backlink = nodesById.get(backlinkId)
      if (
        !['footnote', 'reference'].includes(node.type) ||
        !backlink ||
        !targetLists(backlink).includes(node.id)
      ) {
        issues.push(
          issue(
            'invalid-relationship',
            `Backlink ${backlinkId} must point to ${node.id}.`,
            { nodeId: node.id },
          ),
        )
      }
    }
  }

  for (const artifact of provenArtifacts) {
    if (
      artifact.kind !== 'note-relationship' &&
      artifact.kind !== 'citation-relationship'
    ) {
      continue
    }
    for (const targetGroup of targetGroupsForArtifact(artifact)) {
      const represented = proposal.nodes.some((source) => {
        if (!sourceMatchesArtifact(source, artifact)) return false
        const targetIds =
          artifact.kind === 'note-relationship'
            ? (source.relationships?.noteTargetNodeIds ?? [])
            : (source.relationships?.citationTargetNodeIds ?? [])
        return targetIds.some((targetId) => {
          const target = nodesById.get(targetId)
          return target ? targetMatchesGroup(target, targetGroup) : false
        })
      })
      if (!represented) {
        issues.push(
          issue(
            'invalid-relationship',
            `Deterministic relationship ${artifact.id} is missing a proven target from the proposal.`,
          ),
        )
      }
    }
  }
}

/**
 * Verify and materialize a model proposal.  On any violation this function
 * returns no document; callers must use the deterministic fallback instead of
 * partially publishing a candidate.
 */
export function verifyStructuredExtraction(
  contextInput: StructuredExtractionContext,
  proposalInput: unknown,
): StructuredExtractionVerificationResult {
  let context: StructuredExtractionContext
  let proposal: StructuredExtractionProposal
  try {
    context = parseStructuredExtractionContext(contextInput)
    proposal = parseStructuredExtractionProposal(proposalInput)
  } catch (error) {
    return {
      status: 'failed',
      output: null,
      issues: [
        issue(
          'invalid-output',
          error instanceof z.ZodError
            ? error.issues
                .map((entry) => `${entry.path.join('.')}: ${entry.message}`)
                .join('; ')
            : 'Structured extraction proposal is invalid.',
        ),
      ],
    }
  }

  const issues: StructuredExtractionVerificationIssue[] = []
  const runsById = new Map(context.sourceRuns.map((run) => [run.id, run]))
  const linesById = new Map(
    (context.sourceLines ?? []).map((line) => [line.id, line]),
  )
  const assetsById = new Map(
    context.sourceAssets.map((asset) => [asset.id, asset]),
  )
  const linksById = new Map(
    (context.sourceLinks ?? []).map((link) => [link.id, link]),
  )
  const nodesById = new Map(proposal.nodes.map((node) => [node.id, node]))
  const regionRoleById = new Map(
    (context.regionTopology?.regions ?? []).map(({ id, role }) => [id, role]),
  )
  const claimed = new Set<string>()
  const boilerplate = new Set(context.boilerplateRunIds ?? [])
  const excluded = new Set(proposal.excludedBoilerplateRunIds ?? [])
  const nodes: VerifiedStructuredExtractionNode[] = []

  if (
    new Set(context.sourceRuns.map(({ id }) => id)).size !==
      context.sourceRuns.length ||
    new Set(context.sourceRuns.map(({ order }) => order)).size !==
      context.sourceRuns.length
  ) {
    issues.push(
      issue(
        'invalid-output',
        'Source run identifiers and source order positions must be unique.',
      ),
    )
  }
  if (linesById.size !== (context.sourceLines ?? []).length) {
    issues.push(
      issue('invalid-output', 'Deterministic source line IDs must be unique.'),
    )
  }
  if (context.layout === 'multi-region' && !context.regionTopology) {
    issues.push(
      issue(
        'invalid-region-topology',
        'Multi-region extraction requires a typed region topology.',
      ),
    )
  }
  if (context.regionTopology) {
    const regionIds = new Set(
      context.regionTopology.regions.map(({ id }) => id),
    )
    const regionOrders = new Set(
      context.regionTopology.regions.map(({ order }) => order),
    )
    if (
      regionIds.size !== context.regionTopology.regions.length ||
      regionOrders.size !== context.regionTopology.regions.length ||
      context.regionTopology.edges.some(
        ({ fromRegionId, toRegionId }) =>
          fromRegionId === toRegionId ||
          !regionIds.has(fromRegionId) ||
          !regionIds.has(toRegionId),
      ) ||
      context.sourceRuns.some(
        ({ regionId }) => regionId !== undefined && !regionIds.has(regionId),
      )
    ) {
      issues.push(
        issue(
          'invalid-region-topology',
          'Region IDs, orders, edges, and source-run ownership must form one closed topology.',
        ),
      )
    }
  }
  const lineOwnedRunIds = new Set<string>()
  for (const line of context.sourceLines ?? []) {
    if (new Set(line.sourceRunIds).size !== line.sourceRunIds.length) {
      issues.push(
        issue(
          'invalid-output',
          `Source line ${line.id} run ownership must be unique.`,
        ),
      )
    }
    for (const sourceRunId of line.sourceRunIds) {
      const run = runsById.get(sourceRunId)
      if (!run || run.lineId !== line.id || lineOwnedRunIds.has(sourceRunId)) {
        issues.push(
          issue(
            'invalid-output',
            `Source line ${line.id} has invalid run ownership.`,
            { sourceRunId },
          ),
        )
      }
      lineOwnedRunIds.add(sourceRunId)
    }
  }
  if (
    new Set(context.sourceAssets.map(({ id }) => id)).size !==
    context.sourceAssets.length
  ) {
    issues.push(
      issue(
        'invalid-output',
        'Deterministic asset identifiers must be unique.',
      ),
    )
  }
  if (linksById.size !== (context.sourceLinks ?? []).length) {
    issues.push(
      issue('invalid-link', 'Deterministic source link IDs must be unique.'),
    )
  }
  for (const sourceLink of context.sourceLinks ?? []) {
    if (
      new Set(sourceLink.sourceAssetIds ?? []).size !==
        (sourceLink.sourceAssetIds ?? []).length ||
      new Set(sourceLink.sourceObjectIds ?? []).size !==
        (sourceLink.sourceObjectIds ?? []).length
    ) {
      issues.push(
        issue(
          'invalid-link',
          `Deterministic source link ${sourceLink.id} has duplicate asset ownership.`,
        ),
      )
    }
    if (
      sourceLink.sourceRunIds.length === 0 &&
      ((sourceLink.sourceAssetIds?.length ?? 0) === 0 ||
        (sourceLink.sourceObjectIds?.length ?? 0) === 0)
    ) {
      issues.push(
        issue(
          'invalid-link',
          `Image-only link ${sourceLink.id} must name its exact deterministic asset and source objects.`,
        ),
      )
    }
  }

  if (nodesById.size !== proposal.nodes.length) {
    issues.push(issue('invalid-output', 'Node identifiers must be unique.'))
  }
  // `validateNodeText` only orders the runs *within* one node, so two nodes can
  // be supplied back to front with each one internally sorted. The proposal
  // order is what the verified document publishes, so it has to hold across
  // node boundaries too.
  let previousNodeOrder: { id: string; order: number } | undefined
  for (const node of proposal.nodes) {
    const nodeOrders = nodeOwnedSourceRunIds(node)
      .map((sourceRunId) => runsById.get(sourceRunId)?.order)
      .filter((order): order is number => order !== undefined)
    if (nodeOrders.length > 0) {
      const first = Math.min(...nodeOrders)
      if (previousNodeOrder && first < previousNodeOrder.order) {
        issues.push(
          issue(
            'unverified-span',
            `Node ${node.id} is emitted after ${previousNodeOrder.id} but starts earlier in source order.`,
            { nodeId: node.id },
          ),
        )
      }
      previousNodeOrder = { id: node.id, order: Math.max(...nodeOrders) }
    }
    if (
      node.type === 'heading' &&
      (node.level === undefined || node.level < 1 || node.level > 6)
    ) {
      issues.push(
        issue(
          'invalid-heading-level',
          'Headings require a level from 1 through 6.',
          { nodeId: node.id },
        ),
      )
    }
    if (
      node.type !== 'heading' &&
      node.sourceRunIds.some(
        (sourceRunId) =>
          regionRoleById.get(runsById.get(sourceRunId)?.regionId ?? '') ===
          'heading',
      )
    ) {
      issues.push(
        issue(
          'semantic-role-mismatch',
          `Heading-region source runs cannot be laundered into ${node.type}.`,
          { nodeId: node.id },
        ),
      )
    }
    // The alt-text checks below are figure-only, but the verified node copies
    // `altText` unconditionally. Without this, a paragraph carrying
    // `altTextSource: 'model'` lands invented text in a source-backed document.
    if (node.type !== 'figure' && node.altText !== undefined) {
      issues.push(
        issue(
          'model-authored-alt-text',
          `Only a figure may carry alt text; ${node.id} is a ${node.type}.`,
          { nodeId: node.id },
        ),
      )
    }
    if (node.type !== 'table' && node.table !== undefined) {
      issues.push(
        issue(
          'invalid-table',
          `Only a table node may carry semantic cells; ${node.id} is a ${node.type}.`,
          { nodeId: node.id },
        ),
      )
    }
    const claimedBeforeNode = new Set(claimed)
    const text = validateNodeText(node, runsById, linesById, claimed, issues)
    for (const sourceRunId of node.sourceRunIds) {
      if (boilerplate.has(sourceRunId)) {
        issues.push(
          issue(
            'boilerplate-in-body',
            `Boilerplate run ${sourceRunId} cannot enter body flow.`,
            { nodeId: node.id, sourceRunId },
          ),
        )
      }
    }
    // Table cells are the semantic spans. Their source runs may also be
    // listed on the table node so the node itself remains source anchored;
    // avoid treating that intentional containment as duplicate emission.
    const tableClaimed =
      node.type === 'table' ? new Set(claimedBeforeNode) : claimed
    const table = verifyNodeTable(
      node,
      runsById,
      context.provenArtifacts ?? [],
      tableClaimed,
      issues,
      boilerplate,
    )
    if (node.type === 'table') {
      for (const sourceRunId of tableClaimed) claimed.add(sourceRunId)
      // The node-level source references and cell-level references describe
      // the same source ownership, not two emitted text spans.
      const nodeSourceCounts = new Map<string, number>()
      for (const sourceRunId of node.sourceRunIds) {
        nodeSourceCounts.set(
          sourceRunId,
          (nodeSourceCounts.get(sourceRunId) ?? 0) + 1,
        )
      }
      for (const sourceRunId of node.sourceRunIds) {
        const duplicate = issues.find(
          (entry) =>
            entry.code === 'duplicate-source-run' &&
            entry.nodeId === node.id &&
            entry.sourceRunId === sourceRunId,
        )
        if (
          duplicate &&
          nodeSourceCounts.get(sourceRunId) === 1 &&
          !claimedBeforeNode.has(sourceRunId) &&
          tableClaimed.has(sourceRunId)
        ) {
          const index = issues.indexOf(duplicate)
          issues.splice(index, 1)
        }
      }
    }
    verifyAsset(node, context, assetsById, nodesById, issues)
    const captionText =
      node.type === 'figure'
        ? captionTextForNode(node, nodesById, runsById)
        : undefined
    if (node.type === 'figure' && captionText !== undefined) {
      // Never carry proposal text into the verified graph. Caption-derived alt
      // text is rebuilt from the source run ledger even when the proposal did
      // not include an altText field.
      node.altText = captionText
      node.altTextSource = 'caption'
    }
    nodes.push({
      id: node.id,
      type: node.type,
      sourceRunIds: [...node.sourceRunIds],
      text,
      ...(node.level === undefined ? {} : { level: node.level }),
      ...(node.assetId === undefined ? {} : { assetId: node.assetId }),
      ...(node.captionNodeId === undefined
        ? {}
        : { captionNodeId: node.captionNodeId }),
      ...(node.altText === undefined ? {} : { altText: node.altText }),
      ...(node.altTextSource === 'caption'
        ? { altTextSource: 'caption' as const }
        : {}),
      ...(node.relationships
        ? {
            relationships: {
              ...(node.relationships.noteTargetNodeIds
                ? {
                    noteTargetNodeIds: [
                      ...node.relationships.noteTargetNodeIds,
                    ],
                  }
                : {}),
              ...(node.relationships.citationTargetNodeIds
                ? {
                    citationTargetNodeIds: [
                      ...node.relationships.citationTargetNodeIds,
                    ],
                  }
                : {}),
              ...(node.relationships.backlinks
                ? { backlinks: [...node.relationships.backlinks] }
                : {}),
            },
          }
        : {}),
      provenance: { sourceRunIds: [...node.sourceRunIds] },
      ...(table ? { table } : {}),
    })
  }

  verifyRelationships(context, proposal, nodesById, issues)

  for (const sourceRunId of excluded) {
    if (!boilerplate.has(sourceRunId)) {
      issues.push(
        issue(
          'boilerplate-not-accounted',
          `Run ${sourceRunId} is not declared boilerplate.`,
          { sourceRunId },
        ),
      )
    }
    if (!runsById.has(sourceRunId)) {
      issues.push(
        issue('unknown-source-run', `Unknown boilerplate run ${sourceRunId}.`, {
          sourceRunId,
        }),
      )
    }
  }
  for (const sourceRunId of boilerplate) {
    if (!runsById.has(sourceRunId)) {
      issues.push(
        issue('unknown-source-run', `Unknown boilerplate run ${sourceRunId}.`, {
          sourceRunId,
        }),
      )
    }
    if (!excluded.has(sourceRunId) && !claimed.has(sourceRunId)) {
      issues.push(
        issue(
          'boilerplate-not-accounted',
          `Boilerplate run ${sourceRunId} was neither excluded nor emitted.`,
          { sourceRunId },
        ),
      )
    }
  }

  for (const sourceRun of context.sourceRuns) {
    if (!boilerplate.has(sourceRun.id) && !claimed.has(sourceRun.id)) {
      issues.push(
        issue(
          'missing-source-run',
          `Non-boilerplate source run ${sourceRun.id} has no materialized owner or bounded source fallback.`,
          { sourceRunId: sourceRun.id },
        ),
      )
    }
  }

  const proposalAssetIds = proposal.assetIds ?? []
  if (new Set(proposalAssetIds).size !== proposalAssetIds.length) {
    issues.push(
      issue('duplicate-asset', 'Materialized asset IDs must be unique.'),
    )
  }
  const nodeAssetCounts = new Map<string, number>()
  for (const node of proposal.nodes) {
    if (!node.assetId) continue
    nodeAssetCounts.set(
      node.assetId,
      (nodeAssetCounts.get(node.assetId) ?? 0) + 1,
    )
  }
  for (const [assetId, count] of nodeAssetCounts) {
    if (count > 1) {
      issues.push(
        issue(
          'duplicate-asset',
          `Deterministic asset ${assetId} has more than one materialized owner.`,
          { assetId },
        ),
      )
    }
  }
  const assetIds = [
    ...new Set([
      ...proposalAssetIds,
      ...proposal.nodes.flatMap((node) => (node.assetId ? [node.assetId] : [])),
    ]),
  ]
  for (const assetId of assetIds) {
    if (!assetsById.has(assetId))
      issues.push(
        issue('unknown-asset', `Unknown deterministic asset ${assetId}.`, {
          assetId,
        }),
      )
  }
  for (const asset of context.sourceAssets) {
    if ((asset.required ?? true) && !assetIds.includes(asset.id)) {
      issues.push(
        issue(
          'missing-asset',
          `Required deterministic asset ${asset.id} has no materialized asset or bounded source fallback.`,
          { assetId: asset.id },
        ),
      )
    }
  }

  const claimedLinks = new Set<string>()
  const materializedLinks: VerifiedStructuredExtraction['links'] = []
  for (const proposedLink of proposal.links ?? []) {
    const sourceLink = linksById.get(proposedLink.sourceLinkId)
    const sourceNode = nodesById.get(proposedLink.sourceNodeId)
    if (!sourceLink || !sourceNode) {
      issues.push(
        issue(
          'invalid-link',
          `Link ${proposedLink.sourceLinkId} must name a deterministic source link and materialized source node.`,
          { nodeId: proposedLink.sourceNodeId },
        ),
      )
      continue
    }
    if (claimedLinks.has(sourceLink.id)) {
      issues.push(
        issue(
          'duplicate-link',
          `Source link ${sourceLink.id} has more than one materialized owner.`,
          { nodeId: sourceNode.id },
        ),
      )
      continue
    }
    if (
      sourceLink.sourceRunIds.length > 0 &&
      !sourceLink.sourceRunIds.some((id) =>
        nodeOwnedSourceRunIds(sourceNode).includes(id),
      )
    ) {
      issues.push(
        issue(
          'invalid-link',
          `Source node ${sourceNode.id} does not own the source anchor for link ${sourceLink.id}.`,
          { nodeId: sourceNode.id },
        ),
      )
      continue
    }
    if (sourceLink.sourceRunIds.length === 0) {
      const anchoredAsset = sourceNode.assetId
        ? assetsById.get(sourceNode.assetId)
        : undefined
      const exactAssetOwner =
        anchoredAsset !== undefined &&
        (sourceLink.sourceAssetIds ?? []).length === 1 &&
        sourceLink.sourceAssetIds![0] === anchoredAsset.id &&
        canonicalStringSet(anchoredAsset.sourceObjectIds) ===
          canonicalStringSet(sourceLink.sourceObjectIds ?? [])
      const overlaps =
        anchoredAsset !== undefined &&
        anchoredAsset.page === sourceLink.page &&
        Math.max(anchoredAsset.bounds.x, sourceLink.box.x) <
          Math.min(
            anchoredAsset.bounds.x + anchoredAsset.bounds.width,
            sourceLink.box.x + sourceLink.box.width,
          ) &&
        Math.max(anchoredAsset.bounds.y, sourceLink.box.y) <
          Math.min(
            anchoredAsset.bounds.y + anchoredAsset.bounds.height,
            sourceLink.box.y + sourceLink.box.height,
          )
      if (!exactAssetOwner || !overlaps) {
        issues.push(
          issue(
            'invalid-link',
            `Image-only link ${sourceLink.id} must be owned by the exact overlapping deterministic asset node.`,
            { nodeId: sourceNode.id },
          ),
        )
        continue
      }
    }
    if (sourceLink.destination.kind === 'external') {
      const protocol = new URL(sourceLink.destination.url).protocol
      if (!['http:', 'https:', 'mailto:'].includes(protocol)) {
        issues.push(
          issue(
            'invalid-link',
            `Source link ${sourceLink.id} has an unsafe external destination.`,
            { nodeId: sourceNode.id },
          ),
        )
        continue
      }
    }
    claimedLinks.add(sourceLink.id)
    materializedLinks.push({
      sourceLinkId: sourceLink.id,
      sourceNodeId: sourceNode.id,
      destination: structuredClone(sourceLink.destination),
    })
  }
  for (const sourceLink of context.sourceLinks ?? []) {
    if (!claimedLinks.has(sourceLink.id)) {
      issues.push(
        issue(
          'missing-link',
          `Deterministic source link ${sourceLink.id} has no materialized link or unresolved source-preserved fallback.`,
        ),
      )
    }
  }
  const accountedSourceRunIds = [...new Set([...claimed, ...excluded])].sort()
  if (issues.length > 0) return { status: 'failed', output: null, issues }
  const relationshipIds = (context.provenArtifacts ?? [])
    .filter(({ kind }) => kind.endsWith('-relationship'))
    .map(({ id }) => id)
    .sort()
  return {
    status: 'passed',
    issues: [],
    output: {
      schemaVersion: STRUCTURED_EXTRACTION_SCHEMA_VERSION,
      documentId: context.documentId,
      sourceSha256: context.sourceSha256,
      nodes,
      assetIds: assetIds.sort(),
      excludedBoilerplateRunIds: [...excluded].sort(),
      accountedSourceRunIds,
      links: materializedLinks.sort((left, right) =>
        left.sourceLinkId.localeCompare(right.sourceLinkId),
      ),
      relationshipIds,
    },
  }
}

export function verifyStructuredExtractionOrThrow(
  context: StructuredExtractionContext,
  proposal: unknown,
) {
  const result = verifyStructuredExtraction(context, proposal)
  if (result.status === 'failed') {
    throw new Error(
      result.issues
        .map(({ code, message }) => `${code}: ${message}`)
        .join('\n'),
    )
  }
  return result.output
}

// Public vocabulary aliases used by callers that refer to the shared
// contract as "structured output" rather than "structured extraction".
export const verifyStructuredOutput = verifyStructuredExtraction
export const verifyStructuredOutputOrThrow = verifyStructuredExtractionOrThrow

/** Build the source-only input each candidate is allowed to receive. */
export function modelInputForStructuredExtraction(
  context: StructuredExtractionContext,
  arm: 'geometric-baseline' | 'llm-authored' | 'llm-grounded',
): StructuredExtractionContext {
  const base: StructuredExtractionContext = {
    documentId: context.documentId,
    sourceSha256: context.sourceSha256,
    split: context.split,
    layout: context.layout,
    ...(context.regionTopology
      ? {
          regionTopology: {
            regions: context.regionTopology.regions.map((region) => ({
              ...region,
              bounds: { ...region.bounds },
            })),
            edges: context.regionTopology.edges.map((edge) => ({ ...edge })),
          },
        }
      : {}),
    sourceRuns: context.sourceRuns.map((run) => ({ ...run })),
    ...(context.sourceLines
      ? {
          sourceLines: context.sourceLines.map((line) => ({
            ...line,
            sourceRunIds: [...line.sourceRunIds],
          })),
        }
      : {}),
    sourceAssets: context.sourceAssets.map((asset) => ({
      ...asset,
      bounds: { ...asset.bounds },
      sourceObjectIds: [...asset.sourceObjectIds],
      ...(asset.captionRunIds
        ? { captionRunIds: [...asset.captionRunIds] }
        : {}),
    })),
    ...(context.sourceLinks
      ? {
          sourceLinks: context.sourceLinks.map((link) => ({
            ...link,
            sourceRunIds: [...link.sourceRunIds],
            ...(link.sourceAssetIds
              ? { sourceAssetIds: [...link.sourceAssetIds] }
              : {}),
            ...(link.sourceObjectIds
              ? { sourceObjectIds: [...link.sourceObjectIds] }
              : {}),
            box: { ...link.box },
            destination: { ...link.destination },
          })),
        }
      : {}),
    ...(context.pageRenditions
      ? {
          pageRenditions: context.pageRenditions.map((rendition) => ({
            ...rendition,
          })),
        }
      : {}),
    ...(arm !== 'llm-authored' && context.boilerplateRunIds
      ? { boilerplateRunIds: [...context.boilerplateRunIds] }
      : {}),
  }
  if (arm === 'geometric-baseline' || arm === 'llm-grounded') {
    base.provenArtifacts = (context.provenArtifacts ?? []).map((artifact) => ({
      ...artifact,
      sourceRunIds: [...artifact.sourceRunIds],
      ...(artifact.targetSourceRunIds
        ? { targetSourceRunIds: [...artifact.targetSourceRunIds] }
        : {}),
      ...(artifact.targetSourceRunIdGroups
        ? {
            targetSourceRunIdGroups: artifact.targetSourceRunIdGroups.map(
              (group) => [...group],
            ),
          }
        : {}),
      ...(artifact.tableRows
        ? {
            tableRows: artifact.tableRows.map(({ cells }) => ({
              cells: cells.map((cell) => ({
                ...cell,
                sourceRunIds: [...cell.sourceRunIds],
              })),
            })),
          }
        : {}),
    }))
  }
  return deepFreeze(base)
}

export function isStructuredExtractionByteStable(
  first: VerifiedStructuredExtraction,
  second: VerifiedStructuredExtraction,
) {
  return (
    structuredExtractionStableJson(first) ===
    structuredExtractionStableJson(second)
  )
}
