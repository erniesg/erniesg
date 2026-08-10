import { z } from 'zod'
import {
  assetBundleSchema,
  serializeAssetBundle,
  type AssetBundle,
} from './asset-bundle'
import {
  assertSupportedVersion,
  boundedText,
  canonicalIdSchema,
  canonicalPublicationJson,
  isSafeSourceReference,
  publicationGraphSchema,
  serializePublicationGraph,
  sourceReferenceSchema,
  type PublicationGraph,
  PUBLICATION_LIMITS,
} from './schema'

export const PUBLICATION_SOURCE_ADAPTER_VERSION = '1.0.0' as const

export const SUPPORTED_SOURCE_ADAPTER_VERSIONS = [
  PUBLICATION_SOURCE_ADAPTER_VERSION,
] as const

export const SOURCE_KINDS = [
  'astro',
  'payload',
  'docx',
  'pdf',
  'research-paper',
] as const

export const SOURCE_DIAGNOSTIC_CODES = [
  'unsupported-source-feature',
  'dropped-source-geometry',
  'missing-accessibility-alternative',
  'unsafe-url-rejected',
  'unresolved-asset-reference',
  'unproven-locale',
] as const

export const SOURCE_DIAGNOSTIC_LIMIT = 1_000

export const sourceDiagnosticSchema = z
  .object({
    code: z.enum(SOURCE_DIAGNOSTIC_CODES),
    severity: z.enum(['info', 'warning', 'error']),
    message: boundedText(PUBLICATION_LIMITS.shortText),
    nodeId: canonicalIdSchema.optional(),
  })
  .strict()

export type SourceDiagnostic = z.infer<typeof sourceDiagnosticSchema>

export const sourceProvenanceSchema = z
  .object({
    adapterId: canonicalIdSchema,
    adapterVersion: boundedText(64),
    sourceKind: z.enum(SOURCE_KINDS),
    sourceId: sourceReferenceSchema,
    sourceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    capturedAt: z.string().datetime({ offset: true }),
  })
  .strict()

export type SourceProvenance = z.infer<typeof sourceProvenanceSchema>

/**
 * The compiler boundary. A source adapter returns meaning plus evidence; bytes
 * stay behind the bundle's resolver and never enter graph JSON.
 */
export const publicationSourceResultSchema = z
  .object({
    version: z.literal(PUBLICATION_SOURCE_ADAPTER_VERSION),
    graph: publicationGraphSchema,
    assetBundle: assetBundleSchema,
    diagnostics: z.array(sourceDiagnosticSchema).max(SOURCE_DIAGNOSTIC_LIMIT),
    provenance: sourceProvenanceSchema,
  })
  .strict()
  .superRefine((result, context) => {
    const assetIds = new Set(result.assetBundle.assets.map((asset) => asset.id))
    for (const [index, node] of result.graph.nodes.entries()) {
      for (const [refIndex, reference] of node.assetRefs.entries()) {
        if (assetIds.has(reference.assetId)) continue
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['graph', 'nodes', index, 'assetRefs', refIndex, 'assetId'],
          message: `Node ${node.id} references an asset the bundle does not describe: ${reference.assetId}`,
        })
      }
      for (const variant of Object.values(node.authoredVariants)) {
        if (!variant?.assetId || assetIds.has(variant.assetId)) continue
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['graph', 'nodes', index, 'authoredVariants'],
          message: `Authored variant on ${node.id} references an unknown asset: ${variant.assetId}`,
        })
      }
    }
    if (!isSafeSourceReference(result.provenance.sourceId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provenance', 'sourceId'],
        message: 'Provenance must not record local paths or secret material',
      })
    }
  })

export type PublicationSourceResult = z.infer<
  typeof publicationSourceResultSchema
> & {
  graph: PublicationGraph
  assetBundle: AssetBundle
}

export type PublicationSourceAdapter<Input> = {
  id: string
  version: typeof PUBLICATION_SOURCE_ADAPTER_VERSION
  sourceKind: (typeof SOURCE_KINDS)[number]
  read(input: Input): PublicationSourceResult
}

export function defineSourceAdapter<Input>(
  adapter: PublicationSourceAdapter<Input>,
): PublicationSourceAdapter<Input> {
  assertSupportedVersion(
    'publication source adapter',
    adapter.version,
    SUPPORTED_SOURCE_ADAPTER_VERSIONS,
  )
  return adapter
}

export function parsePublicationSourceResult(
  value: unknown,
): PublicationSourceResult {
  const version =
    value && typeof value === 'object' && 'version' in value
      ? (value as { version: unknown }).version
      : undefined
  assertSupportedVersion(
    'publication source adapter',
    version,
    SUPPORTED_SOURCE_ADAPTER_VERSIONS,
  )
  return publicationSourceResultSchema.parse(value) as PublicationSourceResult
}

export function runSourceAdapter<Input>(
  adapter: PublicationSourceAdapter<Input>,
  input: Input,
): PublicationSourceResult {
  assertSupportedVersion(
    'publication source adapter',
    adapter.version,
    SUPPORTED_SOURCE_ADAPTER_VERSIONS,
  )
  return parsePublicationSourceResult(adapter.read(input))
}

/** Deterministic transport form: graph plus descriptors, never resolver state. */
export function serializePublicationSourceResult(
  result: PublicationSourceResult,
) {
  return canonicalPublicationJson({
    version: result.version,
    graph: JSON.parse(serializePublicationGraph(result.graph)),
    assetBundle: JSON.parse(serializeAssetBundle(result.assetBundle)),
    diagnostics: result.diagnostics,
    provenance: result.provenance,
  })
}
