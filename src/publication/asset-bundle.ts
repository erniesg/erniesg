import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  assertSupportedVersion,
  boundedText,
  canonicalIdSchema,
  canonicalPublicationJson,
  publicationProvenanceSchema,
  PUBLICATION_LIMITS,
} from './schema'

export const ASSET_BUNDLE_VERSION = '1.0.0' as const

export const SUPPORTED_ASSET_BUNDLE_VERSIONS = [ASSET_BUNDLE_VERSION] as const

export const ASSET_BUNDLE_LIMITS = {
  assets: 2_000,
  byteLength: 256 * 1024 * 1024,
} as const

export const contentHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'Assets are addressed by a sha256 digest')

export const mediaTypeSchema = z
  .string()
  .max(128)
  .regex(
    /^[a-z]+\/[A-Za-z0-9][A-Za-z0-9.+-]*$/,
    'Media type must be a bounded IANA-shaped type/subtype pair',
  )

export const assetDescriptorSchema = z
  .object({
    id: canonicalIdSchema,
    contentHash: contentHashSchema,
    mediaType: mediaTypeSchema,
    byteLength: z
      .number()
      .int()
      .positive()
      .max(ASSET_BUNDLE_LIMITS.byteLength),
    role: z.enum(['image', 'vector', 'audio', 'video', 'font', 'data']),
    title: boundedText(PUBLICATION_LIMITS.shortText).optional(),
    intrinsic: z
      .object({
        widthPx: z.number().int().positive(),
        heightPx: z.number().int().positive(),
      })
      .strict()
      .optional(),
    provenance: publicationProvenanceSchema,
  })
  .strict()

/**
 * The serialisable half of a bundle. Bytes, local paths, and credentials never
 * appear here; a descriptor only says what the bytes must hash to.
 */
export const assetBundleDataSchema = z
  .object({
    version: z.literal(ASSET_BUNDLE_VERSION),
    assets: z
      .array(assetDescriptorSchema)
      .max(ASSET_BUNDLE_LIMITS.assets),
  })
  .strict()
  .superRefine((bundle, context) => {
    const seenIds = new Set<string>()
    for (const [index, asset] of bundle.assets.entries()) {
      if (seenIds.has(asset.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assets', index, 'id'],
          message: `Duplicate asset id: ${asset.id}`,
        })
      }
      seenIds.add(asset.id)
    }
  })

export type AssetDescriptor = z.infer<typeof assetDescriptorSchema>
export type AssetBundleData = z.infer<typeof assetBundleDataSchema>

/**
 * The byte side of the boundary. Adapters hand back a resolver instead of
 * bytes so a graph can be inspected, hashed, and transported on its own.
 */
export type AssetByteResolver = {
  id: string
  resolve(descriptor: AssetDescriptor): Promise<Uint8Array>
}

export function isAssetByteResolver(value: unknown): value is AssetByteResolver {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AssetByteResolver).id === 'string' &&
    typeof (value as AssetByteResolver).resolve === 'function'
  )
}

export const assetByteResolverSchema = z.custom<AssetByteResolver>(
  isAssetByteResolver,
  { message: 'An asset bundle requires a byte-resolver interface' },
)

export const assetBundleSchema = z
  .object({
    version: z.literal(ASSET_BUNDLE_VERSION),
    assets: z.array(assetDescriptorSchema).max(ASSET_BUNDLE_LIMITS.assets),
    resolver: assetByteResolverSchema,
  })
  .strict()
  .superRefine((bundle, context) => {
    const result = assetBundleDataSchema.safeParse({
      version: bundle.version,
      assets: bundle.assets,
    })
    if (result.success) return
    for (const issue of result.error.issues) context.addIssue(issue)
  })

export type AssetBundle = z.infer<typeof assetBundleSchema>

export function assetContentHash(bytes: Uint8Array) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function describeAsset(
  input: Omit<AssetDescriptor, 'contentHash' | 'byteLength'> & {
    bytes: Uint8Array
  },
): AssetDescriptor {
  const { bytes, ...rest } = input
  return assetDescriptorSchema.parse({
    ...rest,
    contentHash: assetContentHash(bytes),
    byteLength: bytes.byteLength,
  })
}

/** An in-memory resolver, used by tests and by adapters that already hold bytes. */
export function createMemoryAssetResolver(
  id: string,
  bytesById: Readonly<Record<string, Uint8Array>>,
): AssetByteResolver {
  return {
    id,
    async resolve(descriptor) {
      const bytes = bytesById[descriptor.id]
      if (!bytes) {
        throw new Error(`Asset ${descriptor.id} is not resolvable`)
      }
      return bytes
    },
  }
}

export const EMPTY_ASSET_RESOLVER: AssetByteResolver = createMemoryAssetResolver(
  'empty',
  {},
)

export function createAssetBundle(
  assets: readonly AssetDescriptor[],
  resolver: AssetByteResolver,
): AssetBundle {
  return assetBundleSchema.parse({
    version: ASSET_BUNDLE_VERSION,
    assets: [...assets],
    resolver,
  })
}

export function parseAssetBundleData(value: unknown): AssetBundleData {
  const version =
    value && typeof value === 'object' && 'version' in value
      ? (value as { version: unknown }).version
      : undefined
  assertSupportedVersion(
    'asset bundle',
    version,
    SUPPORTED_ASSET_BUNDLE_VERSIONS,
  )
  return assetBundleDataSchema.parse(value)
}

/** Serialises descriptors only; the resolver is runtime state, not content. */
export function serializeAssetBundle(bundle: AssetBundle | AssetBundleData) {
  return canonicalPublicationJson({
    version: bundle.version,
    assets: bundle.assets,
  })
}

export function findAssetDescriptor(
  bundle: AssetBundle | AssetBundleData,
  assetId: string,
) {
  return bundle.assets.find((asset) => asset.id === assetId)
}

export class AssetIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssetIntegrityError'
  }
}

/**
 * Resolving is the only place bytes enter the compiler, so it is also the only
 * place their content address is proven.
 */
export async function resolveAssetBytes(bundle: AssetBundle, assetId: string) {
  const descriptor = findAssetDescriptor(bundle, assetId)
  if (!descriptor) {
    throw new AssetIntegrityError(`Unknown asset id: ${assetId}`)
  }
  const bytes = await bundle.resolver.resolve(descriptor)
  if (bytes.byteLength !== descriptor.byteLength) {
    throw new AssetIntegrityError(
      `Asset ${assetId} resolved ${bytes.byteLength} bytes; the descriptor declares ${descriptor.byteLength}`,
    )
  }
  const actual = assetContentHash(bytes)
  if (actual !== descriptor.contentHash) {
    throw new AssetIntegrityError(
      `Asset ${assetId} resolved to ${actual}; the descriptor declares ${descriptor.contentHash}`,
    )
  }
  return bytes
}
