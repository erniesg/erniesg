import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { StructDocument } from '@erniesg/struct/document'
import {
  ASSET_BUNDLE_VERSION,
  assetBundleDescriptorSchema,
  createAssetBundle,
  serializeAssetBundle,
  type AssetBundle,
} from './asset-bundle'
import { COMPOSITION_CONTEXT_VERSION } from './profiles'
import {
  PUBLICATION_GRAPH_VERSION,
  publicationGraphSchema,
  serializePublicationGraph,
  type PublicationGraph,
} from './schema'
import {
  legacyResearchPaperSourceBinding,
  publicationSourceBindingSchema,
  type PublicationSourceBinding,
} from './source-binding'
import { structDocumentSha256 } from './struct-source-binding'
import { TRANSFORMATION_POLICY_VERSION } from './transformation-policy'
import { TARGET_PROFILE_VERSION } from '../research/targets'

export const PUBLICATION_SOURCE_ADAPTER_VERSION = '1.0.0' as const
export const PUBLICATION_CONTRACT_RECEIPT_VERSION = '1.0.0' as const

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

export const publicationContractReceiptSchema = z
  .object({
    version: z.literal(PUBLICATION_CONTRACT_RECEIPT_VERSION),
    // Diagnostic back-compat fields. They are never the source identity.
    graphSha256: sha256Schema,
    assetBundleSha256: sha256Schema,
    // The source identity. It is optional only while a source adapter that
    // has not been re-targeted onto a Struct document can still produce a
    // result without one; the published output receipt requires it.
    sourceBinding: publicationSourceBindingSchema.optional(),
    contracts: z
      .object({
        publicationGraph: z.literal(PUBLICATION_GRAPH_VERSION),
        assetBundle: z.literal(ASSET_BUNDLE_VERSION),
        compositionContext: z.literal(COMPOSITION_CONTEXT_VERSION),
        transformationPolicy: z.literal(TRANSFORMATION_POLICY_VERSION),
        sourceAdapter: z.literal(PUBLICATION_SOURCE_ADAPTER_VERSION),
        targetProfile: z.literal(TARGET_PROFILE_VERSION),
      })
      .strict(),
    source: z
      .object({
        adapterId: z.string().min(1).max(256),
        sourceType: z.enum(['astro', 'payload', 'docx', 'pdf', 'research-paper']),
        mappingVersion: z.string().min(1).max(128).optional(),
      })
      .strict()
      .optional(),
    toolchain: z
      .object({
        node: z.string().min(1).max(256),
        packageLockSha256: sha256Schema,
      })
      .strict(),
    repository: z
      .object({
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        dirty: z.literal(false),
      })
      .strict(),
  })
  .strict()

export type PublicationContractReceipt = z.infer<
  typeof publicationContractReceiptSchema
>

export function isSafePublicationSourceId(value: string) {
  let decoded = value
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return false
  }
  if (
    /^(?:file:|[A-Za-z]:[\\/]|\/|\\\\)/i.test(decoded) ||
    /(?:token|secret|password|credential|api[_-]?key)\s*[=:]/i.test(decoded)
  ) {
    return false
  }
  try {
    const url = new URL(decoded)
    return !url.username && !url.password && url.protocol !== 'file:'
  } catch {
    return true
  }
}

const safeSourceIdSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    isSafePublicationSourceId,
    'Source ids cannot contain local paths or secret material',
  )

export const adapterDiagnosticSchema = z
  .object({
    severity: z.enum(['info', 'warning', 'error']),
    code: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9-]+$/),
    message: z.string().min(1).max(100_000),
    sourceId: safeSourceIdSchema.optional(),
    nodeId: z.string().min(1).max(256).optional(),
  })
  .strict()

export const adapterProvenanceSchema = z
  .object({
    adapterId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    adapterVersion: z.literal(PUBLICATION_SOURCE_ADAPTER_VERSION),
    sourceType: z.enum(['astro', 'payload', 'docx', 'pdf', 'research-paper']),
    sourceId: safeSourceIdSchema,
    sourceRevision: safeSourceIdSchema.pipe(z.string().max(256)).optional(),
    mappingVersion: z.string().min(1).max(128).optional(),
  })
  .strict()

export type AdapterDiagnostic = z.infer<typeof adapterDiagnosticSchema>
export type AdapterProvenance = z.infer<typeof adapterProvenanceSchema>

export type PublicationSourceResult = {
  graph: PublicationGraph
  assetBundle: AssetBundle
  diagnostics: AdapterDiagnostic[]
  provenance: AdapterProvenance
  /**
   * The pinned approved Struct revision this result was derived from. It is
   * absent on the legacy ResearchPaper path and on any source that has not
   * been re-targeted onto a Struct document yet.
   */
  structDocument?: StructDocument
  /**
   * The source binding the receipts carry. It is the source identity; the
   * graph and asset digests beside it are diagnostic back-compat fields.
   *
   * It is optional only while a source adapter that has not been re-targeted
   * onto a Struct document can still produce a result without one. A
   * `struct-cutover` binding always requires the Struct document it was
   * derived from, so its digests can never be asserted without the bytes
   * they describe.
   */
  sourceBinding?: PublicationSourceBinding
}

export interface PublicationSourceAdapter<Input = unknown> {
  readonly id: string
  readonly version: typeof PUBLICATION_SOURCE_ADAPTER_VERSION
  adapt(
    input: Input,
  ): Promise<PublicationSourceResult> | PublicationSourceResult
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Resolve the source binding of a source result and cross-check it against
 * the provenance and the Struct document it was derived from.
 *
 * A supplied binding is parsed by the strict schema, so an unknown field, a
 * malformed digest or a non-hex package commit is refused. A Struct binding
 * is only accepted for a source that is not the legacy ResearchPaper path,
 * and only together with the Struct document, whose canonical digest must
 * equal the binding's `documentSha256`. The legacy variant is accepted only
 * for the ResearchPaper path and carries no Struct field at all.
 *
 * A ResearchPaper source that supplies no binding is given the legacy
 * variant, because that path has no Struct document to bind to. Any other
 * source without a binding has no identity yet and is left unbound rather
 * than given a fabricated one.
 */
function resolveSourceBinding(
  value: PublicationSourceResult,
  provenance: AdapterProvenance,
): PublicationSourceBinding | undefined {
  if (value.sourceBinding) {
    const binding = publicationSourceBindingSchema.parse(value.sourceBinding)
    if (binding.kind === 'struct-cutover') {
      if (provenance.sourceType === 'research-paper')
        throw new Error(
          'Publication source binding kind does not match its source type: struct-cutover for research-paper',
        )
      if (!value.structDocument)
        throw new Error(
          'Publication source results with a Struct binding require the Struct document they were derived from',
        )
      if (binding.documentSha256 !== structDocumentSha256(value.structDocument))
        throw new Error(
          'Publication source binding document digest does not match the Struct document it was derived from',
        )
      return binding
    }
    if (provenance.sourceType !== 'research-paper')
      throw new Error(
        `Publication source binding kind does not match its source type: legacy-research-paper for ${provenance.sourceType}`,
      )
    return binding
  }
  if (provenance.sourceType === 'research-paper')
    return legacyResearchPaperSourceBinding()
  return undefined
}

export function createPublicationContractReceipt(
  value: PublicationSourceResult,
  environment: Pick<PublicationContractReceipt, 'toolchain' | 'repository'>,
): PublicationContractReceipt {
  const result = validatePublicationSourceResult(value)
  return publicationContractReceiptSchema.parse({
    version: PUBLICATION_CONTRACT_RECEIPT_VERSION,
    graphSha256: sha256(serializePublicationGraph(result.graph)),
    assetBundleSha256: sha256(serializeAssetBundle(result.assetBundle)),
    ...(result.sourceBinding
      ? { sourceBinding: result.sourceBinding }
      : {}),
    contracts: {
      publicationGraph: PUBLICATION_GRAPH_VERSION,
      assetBundle: ASSET_BUNDLE_VERSION,
      compositionContext: COMPOSITION_CONTEXT_VERSION,
      transformationPolicy: TRANSFORMATION_POLICY_VERSION,
      sourceAdapter: PUBLICATION_SOURCE_ADAPTER_VERSION,
      targetProfile: TARGET_PROFILE_VERSION,
    },
    source: {
      adapterId: result.provenance.adapterId,
      sourceType: result.provenance.sourceType,
      ...(result.provenance.mappingVersion
        ? { mappingVersion: result.provenance.mappingVersion }
        : {}),
    },
    toolchain: environment.toolchain,
    repository: environment.repository,
  })
}

export function validatePublicationSourceResult(
  value: PublicationSourceResult,
): PublicationSourceResult {
  const graph = publicationGraphSchema.parse(value.graph)
  const descriptor = assetBundleDescriptorSchema.parse(
    value.assetBundle.descriptor,
  )
  if (typeof value.assetBundle.resolveBytes !== 'function') {
    throw new TypeError(
      'Publication source results require an asset byte resolver',
    )
  }
  const assetIds = new Set(descriptor.assets.map((asset) => asset.id))
  graph.nodes.forEach((node) => {
    const referenced =
      node.type === 'figure'
        ? node.assetIds
        : node.type === 'media'
          ? [node.assetId]
          : node.variants.flatMap((variant) =>
              variant.assetId ? [variant.assetId] : [],
            )
    referenced.forEach((assetId) => {
      if (!assetIds.has(assetId)) {
        throw new Error(
          `Publication node ${node.id} references missing asset ${assetId}`,
        )
      }
    })
  })
  const diagnostics = z
    .array(adapterDiagnosticSchema)
    .max(10_000)
    .parse(value.diagnostics)
  const provenance = adapterProvenanceSchema.parse(value.provenance)
  const sourceBinding = resolveSourceBinding(value, provenance)
  return {
    graph,
    assetBundle: createAssetBundle(descriptor, value.assetBundle.resolveBytes),
    diagnostics,
    provenance,
    ...(value.structDocument ? { structDocument: value.structDocument } : {}),
    ...(sourceBinding ? { sourceBinding } : {}),
  }
}
